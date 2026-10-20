const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ root: path.resolve(__dirname, '..'), configFile: false, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 1427, strictPort: true, watch: null } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1808, height: 1088 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); localStorage.setItem('easy-cli-proxy-api.theme', 'light'); });
    await page.goto('http://127.0.0.1:1427/?mock=running');
    await page.waitForFunction(() => document.querySelector('.quota-refresh') && !document.querySelector('.quota-refresh').disabled);
    // Ten synthetic credentials exercise the reference density without touching real accounts.
    await page.evaluate(() => {
      const providers = [...Array(5).fill('claude'), ...Array(3).fill('codex'), 'xai', 'kimi'];
      const files = providers.map((provider, i) => ({ name: `${provider}-account-${String(i + 1).padStart(2, '0')}.json`, auth_index: `ledger-${i}`, provider, status: 'active', disabled: false, priority: 10 - i, account_id: `sample-${i}` }));
      const original = window.__TAURI_INTERNALS__.invoke;
      const reset = days => new Date(Date.now() + days * 86400000).toISOString();
      window.ledgerRequests = [];
      window.__TAURI_INTERNALS__.invoke = async (command, args, ...rest) => {
        const req = args?.request;
        if (command === 'management_request' && req?.path === '/credentials' && req.method === 'GET') return { files: window.reverseLedger ? [...files].reverse() : files };
        if (command === 'management_request' && req?.path === '/requests/api-call' && String(req.body?.authIndex).startsWith('ledger-')) {
          const index = Number(req.body.authIndex.split('-')[1]);
          const url = req.body.url;
          window.ledgerRequests.push({ index, url });
          if (window.failLedger && index === 0 && url.includes('/api/oauth/usage')) return { status_code: 429, body: { error: 'Synthetic quota refresh failure' } };
          // Claude quota issues more than one usage request; hold them all and release them together.
          if (window.holdLedger && index === 0 && url.includes('/api/oauth/usage')) await new Promise(resolve => { (window.ledgerHolds ||= []).push(resolve); window.releaseLedger = () => window.ledgerHolds.splice(0).forEach(release => release()); });
          if (url.includes('/api/oauth/profile')) return { status_code: 200, body: { account: { has_claude_max: true } } };
          if (url.includes('/api/oauth/usage')) return { status_code: 200, body: {
            five_hour: { utilization: index === 3 ? 1 : 0, resets_at: reset(.125) },
            seven_day: { utilization: [21, 0, 0, 25, 0][index], resets_at: reset([1, 4, 4, 1, 5][index]) },
            iguana_necktie: { utilization: [42, 0, 0, 49, 0][index], resets_at: reset([1, 4, 4, 1, 5][index]) },
          } };
          if (url.includes('wham/usage')) return { status_code: 200, body: { plan_type: 'Pro', rate_limit: {
            primary_window: { used_percent: [12, 64, 90][index - 5], reset_after_seconds: 7200, limit_window_seconds: 18000 },
            secondary_window: { used_percent: [95, 93, 95][index - 5], reset_after_seconds: 172800, limit_window_seconds: 604800 },
          } } };
          if (index === 8) return { status_code: 200, body: { config: { currentPeriod: { type: 'weekly' } } } };
          if (index === 9) return { status_code: 200, body: { limits: [{ label: 'Weekly limit', limit: 100, used: 0, reset_at: reset(5) }] } };
          return { status_code: 200, body: {} };
        }
        return original(command, args, ...rest);
      };
    });
    await page.getByRole('button', { name: 'Refresh accounts', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.quota-refresh').disabled && document.querySelector('.ad-list-heading'));
    // Account availability is Overview's main content: every account shows, with its controls.
    assert.equal(await page.locator('.ad-list-heading h3').innerText(), 'Account availability');
    await page.waitForFunction(() => document.querySelectorAll('.ad-card').length === 10);
    assert.equal(await page.locator('.quota-workflow-tools').count(), 1);
    // Rarely changed display choices sit behind Display.
    assert.equal(await page.locator('.ad-display-options').evaluate(node => node.open), false);
    assert.equal(await page.locator('.ad-list-heading').getByRole('button', { name: 'Manage accounts', exact: true }).count(), 1);
    assert.equal(await page.locator('.quota-provider-summary-cell').count(), 4);
    // Compact filters: the count lines are hover text (and read out), not extra lines.
    assert.match(await page.locator('.quota-provider-summary-cell').filter({ hasText: 'Grok' }).getAttribute('title'), /Remaining quota not reported/);
    assert.match(await page.locator('.quota-provider-summary-cell').filter({ hasText: 'Grok' }).locator('.sr-only').innerText(), /Remaining quota not reported/);
    assert.ok((await page.locator('.quota-provider-summary-cell').first().boundingBox()).height < 100, 'provider filters stay compact');
    assert.equal(await page.locator('.quota-provider-summary-cell').first().locator('.quota-summary-value').innerText(), '5');
    assert.ok((await page.locator('.quota-provider-summary-cell').first().innerText()).includes('of 5 accounts available'));
    assert.equal(await page.locator('.quota-provider-summary-cell').nth(1).locator('.quota-summary-value').innerText(), '3');
    // Summary segments fill to each account's tightest window, like the rows: Claude stays green, Codex (5-7% left) runs low.
    const segments = cell => page.locator('.quota-provider-summary-cell').nth(cell).locator('.quota-account-state').evaluateAll(nodes => nodes.map(node => ({ tone: [...node.classList].find(name => name.startsWith('tone-')), fill: node.style.getPropertyValue('--quota-fill'), label: node.getAttribute('aria-label') })));
    const claudeSegments = await segments(0);
    assert.ok(claudeSegments.every(segment => segment.tone === 'tone-healthy'), JSON.stringify(claudeSegments));
    assert.deepEqual(claudeSegments.map(segment => segment.fill), ['58%', '100%', '100%', '51%', '100%']);
    const codexSegments = await segments(1);
    assert.deepEqual(codexSegments.map(segment => [segment.tone, segment.fill]), [['tone-critical', '5%'], ['tone-critical', '7%'], ['tone-critical', '5%']]);
    assert.match(codexSegments[1].label, /Quota available · 7% left$/);
    assert.match(await page.locator('.quota-provider-summary-cell').nth(1).getAttribute('title'), /3 running low/);
    // The status line names the worst account; the ledger counts the same problems and filters to them.
    const verdict = page.locator('.home-status-verdict');
    assert.match(await verdict.innerText(), /^3 accounts need attention/);
    assert.match(await verdict.innerText(), /codex-account-0[68]\.json has 5% left, resets in 2d/);
    assert.equal(await page.locator('.glance-attention').count(), 0, 'no separate Needs attention card');
    // Only the three that can stop work are counted and marked, matching the status line; unconfirmed Grok is not.
    const attentionFilter = page.locator('.ad-attention-filter');
    assert.equal(await attentionFilter.innerText(), '3 need attention');
    assert.equal(await page.locator('.ad-card.ad-needs-attention').count(), 3);
    await attentionFilter.click();
    assert.equal(await attentionFilter.getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => document.querySelectorAll('.ad-card').length === 3);
    const attentionRows = await page.locator('.ad-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
    assert.ok(attentionRows.every(label => /^codex-account-0\d\.json$/.test(label)), JSON.stringify(attentionRows));
    assert.equal(await page.locator('.ad-card.ad-needs-attention').count(), 3);
    await attentionFilter.click();
    await page.waitForFunction(() => document.querySelectorAll('.ad-card').length === 10);
    const unchecked = page.locator('.account-dashboard > .glance-unconfirmed');
    // Grok doesn't report quota, so it says so, and offers no Check now that could never resolve it.
    assert.match(await unchecked.innerText(), /^1 account on providers that don't report quota\./);
    assert.equal(await unchecked.getByRole('button', { name: 'Check now' }).count(), 0);
    // Clicking a runway tile filters the list to that provider; clicking it again clears the filter.
    const codexFilter = page.locator('.quota-summary-filter').filter({ hasText: 'Codex' });
    await codexFilter.click();
    assert.equal(await codexFilter.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.ad-card').count(), 3);
    assert.ok(await page.locator('.quota-provider-summary-cell.is-selected').count() === 1);
    await codexFilter.click();
    assert.equal(await codexFilter.getAttribute('aria-pressed'), 'false');
    // Tiles: compression mock is off, so activity and provider pace remain; activity reads the mock usage.
    assert.equal(await page.locator('.glance-tile').count(), 2);
    assert.doesNotMatch(await page.locator('.quota-provider-summary-cell').first().getAttribute('title') ?? '', /running low/);
    const claude = page.locator('.quota-account-group').first();
    assert.equal(await claude.locator('.ad-card').count(), 5);
    // The aligned three-limit ledger is an opt-in layout under Display; compact one-row cards are the default.
    await page.locator('.ad-display-options > summary').click();
    await page.getByLabel('Layout', {exact:true}).selectOption('ledger');
    assert.equal(await claude.locator('.ad-quota').count(), 15);
    const rows = await claude.locator('.ad-card').evaluateAll(nodes => nodes.map(node => { const b = node.getBoundingClientRect(); return {height:b.height, bottom:b.bottom}; }));
    assert.ok(rows.every(row => row.height <= 125), `Ledger rows too tall: ${JSON.stringify(rows)}`);
    const screenshot = process.env.LEDGER_SCREENSHOT;
    await page.locator('.quota-refresh').hover();
    assert.ok(await page.locator('.quota-refresh').evaluate(el => {
      const luminance = value => value.match(/[\d.]+/g).slice(0,3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i],0);
      const style = getComputedStyle(el), a = luminance(style.color), b = luminance(style.backgroundColor);
      return (Math.max(a,b)+.05)/(Math.min(a,b)+.05) >= 4.5;
    }), 'Refresh text contrast must survive hover');
    if (screenshot) await page.screenshot({ path: screenshot, fullPage: false, style: '#browser-mock-toolbar { visibility: hidden; }' });
    // Home now opens with the status bar and overview cards; from the accounts heading down, five full Claude rows must fit one reference screen.
    const dashboardTop = (await page.locator('.account-dashboard').boundingBox()).y;
    assert.ok(rows[4].bottom - dashboardTop <= 1088, `Five full Claude rows must fit at reference viewport: ${JSON.stringify({ dashboardTop, rows })}`);
    // Refresh one account from its actions menu, verify in-flight feedback and no background account refresh.
    const firstCard = () => claude.locator('.ad-card').first();
    const openMenu = async () => { await firstCard().getByRole('button', { name: /^Actions for / }).click(); return page.getByRole('menu'); };
    const refreshFirst = async () => { await (await openMenu()).getByRole('menuitem', { name: 'Refresh quota', exact: true }).click(); };
    const refreshDone = () => page.waitForFunction(() => !document.querySelector('.ad-row-busy'));
    await page.evaluate(() => { window.ledgerRequests = []; window.holdLedger = true; });
    await refreshFirst();
    await page.waitForFunction(() => Boolean(window.releaseLedger));
    assert.equal(await firstCard().locator('.ad-row-busy').count(), 1, 'The refreshing account shows in-flight feedback');
    const busyItem = (await openMenu()).getByRole('menuitem', { name: 'Refreshing…', exact: true });
    assert.equal(await busyItem.isDisabled(), true, 'A second refresh cannot start while one is in flight');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.holdLedger = false; window.releaseLedger(); });
    await refreshDone();
    assert.ok((await page.evaluate(() => window.ledgerRequests)).every(request => request.index === 0));
    await page.evaluate(() => { window.failLedger = true; });
    await refreshFirst();
    await claude.locator('.ad-card').first().getByText(/Couldn't read this account's quota./).waitFor();
    await claude.locator('.ad-card').first().locator('.ad-error').getByRole('button', { name: 'Retry' }).waitFor();
    assert.equal(await page.locator('.quota-provider-summary-cell').first().locator('.quota-summary-value').innerText(), '4');
    assert.ok((await page.locator('.quota-provider-summary-cell').first().innerText()).includes('1 Availability unconfirmed'));
    await page.evaluate(() => { window.failLedger = false; });
    await refreshDone();
    await refreshFirst();
    await page.waitForFunction(() => document.querySelector('.quota-summary-value').textContent === '5');
    // Additional provider limits remain available without stretching every row.
    await page.evaluate(async () => {
      const { updateQuotaCache } = await import('/src/services/quotaCache.ts');
      updateQuotaCache(cache => ({ ...cache, 'claude-account-01.json::ledger-0': { ...cache['claude-account-01.json::ledger-0'], rows: [...cache['claude-account-01.json::ledger-0'].rows, { label:'Extra usage', remainingPercent:80 }] } }));
    });
    const moreLimits = claude.locator('.ad-card').first().locator('.ad-account-details > summary');
    await page.waitForFunction(() => document.querySelector('.quota-account-group .ad-card .ad-account-details > summary')?.title === '1 more limit');
    assert.equal(await moreLimits.locator('span[aria-hidden="true"]').innerText(), '+1', 'Extra limits collapse into a +N chevron');
    await moreLimits.click();
    await claude.locator('.ad-card').first().getByText('Extra usage', {exact:true}).waitFor();
    assert.equal(await claude.locator('.ad-card').first().locator('.ad-quota').count(), 4);
    await moreLimits.click();
    assert.equal(await page.locator('.quota-summary-breakdown').count(), 0, 'the ledger rows are the breakdown');
    // Both layouts are one-row cards; compact shows only the deciding limit instead of three aligned columns.
    assert.equal(await claude.locator('.ad-card').first().locator('.ad-row-quota .ad-quota').count(), 3);
    await page.locator('.ad-display-options').evaluate(node => { node.open = true; });
    await page.getByLabel('Layout', {exact:true}).selectOption('compact');
    assert.equal(await claude.locator('.ad-card').first().locator('.ad-row-quota .ad-quota').count(), 1);
    assert.ok((await claude.locator('.ad-card').first().boundingBox()).height <= rows[0].height);
    await page.getByLabel('Layout', {exact:true}).selectOption('ledger');
    // A model-specific full allowance cannot conceal an exhausted overall quota.
    await page.evaluate(async () => {
      const { updateQuotaCache } = await import('/src/services/quotaCache.ts');
      updateQuotaCache(cache => {
        const key = 'claude-account-01.json::ledger-0';
        return { ...cache, [key]: { ...cache[key], rows: cache[key].rows.map(row => row.windowId === 'seven_day' ? { ...row, remainingPercent: 0, resetAtMs: Date.now() + 5 * 86400000 } : row) } };
      });
    });
    await page.locator('.quota-account-exhausted').waitFor();
    assert.equal(await page.locator('.quota-summary-value').first().innerText(), '4');
    assert.ok((await claude.locator('.ad-card').first().locator('.quota-availability-chip').getAttribute('title')).includes('Blocked for 5d'), 'Exhausted chip explains the wait');
    assert.equal(await claude.locator('.ad-quota').first().locator('meter').getAttribute('value'), '0');
    assert.equal(await page.locator('.quota-compare').count(), 1, 'A single Compare alternatives header action appears once an account is limited');
    const alternativeBox=await page.locator('.quota-account-exhausted .ad-menu-button').boundingBox();
    const detailBox=await page.locator('.quota-account-exhausted summary').boundingBox();
    assert.ok(alternativeBox.x+alternativeBox.width<=detailBox.x || detailBox.x+detailBox.width<=alternativeBox.x || alternativeBox.y+alternativeBox.height<=detailBox.y || detailBox.y+detailBox.height<=alternativeBox.y, 'Actions menu and Details must not overlap');
    await page.locator('.quota-account-exhausted').getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menu').getByRole('menuitem',{name:'Compare alternatives',exact:true}).click();
    assert.equal(await claude.locator('.ad-card').count(),5, 'Comparison preserves the ledger and current filters');
    const comparison=page.getByRole('region',{name:'Compare alternatives'});
    await comparison.waitFor();
    assert.ok(!(await comparison.innerText()).includes('claude-account-01.json'), 'Exhausted accounts are not alternatives');
    assert.ok(await comparison.locator('article').count() >= 4);
    await comparison.getByRole('button',{name:'Close',exact:true}).click();
    await page.getByLabel('All states', {exact:true}).selectOption('attention');
    assert.equal(await claude.locator('.ad-card').count(), 1);
    await page.getByLabel('All states', {exact:true}).selectOption('available');
    assert.equal(await claude.locator('.ad-card').count(), 4);
    await page.getByLabel('All states', {exact:true}).selectOption('all');
    await page.getByRole('searchbox', {name:'Search accounts'}).fill('claude-account-01');
    assert.equal(await page.locator('.ad-card').count(), 1);
    await page.getByRole('searchbox', {name:'Search accounts'}).fill('');
    await page.locator('.quota-summary-filter').filter({hasText:'Claude'}).click();
    await page.getByLabel('All states', {exact:true}).selectOption('attention');
    await page.getByRole('navigation', {name:'Main navigation'}).getByRole('button', {name:'Accounts',exact:true}).click();
    // While an account is exhausted, Overview carries a red attention dot (part of its accessible name).
    const overviewNav = page.getByRole('navigation', {name:'Main navigation'}).getByRole('button', {name:/^Overview/});
    assert.equal(await overviewNav.locator('.nav-attention-dot').count(), 1, 'Overview flags the limited account');
    await overviewNav.click();
    await page.waitForFunction(() => !document.querySelector('.quota-refresh')?.disabled);
    assert.equal(await page.locator('.quota-summary-filter').filter({hasText:'Claude'}).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('All states', {exact:true}).inputValue(), 'attention');
    await page.getByRole('searchbox', {name:'Search accounts'}).fill('no-such-account');
    await page.getByText('No accounts match these filters', {exact:true}).waitFor();
    assert.equal(await page.locator('.quota-result-count').innerText(), 'Account list: 0 of 10');
    await page.locator('.quota-no-results').getByRole('button', {name:'Clear filters',exact:true}).click();
    assert.equal(await page.locator('.ad-card').count(), 10);
    assert.equal(await page.locator('.quota-result-count').innerText(), 'Account list: 10 of 10');
    await page.getByRole('searchbox', {name:'Search accounts'}).fill('  claude-account-01  ');
    assert.equal(await page.locator('.ad-card').count(), 1);
    await page.locator('.ad-display-options').evaluate(node => { node.open = true; });
    await page.getByRole('checkbox', {name:'Hide emails'}).check();
    assert.equal(await page.getByRole('searchbox', {name:'Search accounts'}).inputValue(), '');
    const aliases=await page.locator('.ad-card h3').allTextContents();
    assert.equal(aliases.length,10);
    await page.evaluate(()=>{window.reverseLedger=true;});
    await page.locator('.quota-refresh').click();
    await page.waitForFunction(()=>!document.querySelector('.quota-refresh').disabled);
    assert.deepEqual(await page.locator('.ad-card h3').allTextContents(),aliases,'Privacy aliases survive reordered responses');
    await page.getByRole('searchbox',{name:'Search accounts'}).fill(aliases[0]);
    assert.equal(await page.locator('.ad-card').count(),1,'Masked aliases are searchable');
    await page.getByRole('searchbox',{name:'Search accounts'}).fill('');
    await page.locator('.ad-display-options').evaluate(node => { node.open = true; });
    await page.getByRole('checkbox', {name:'Hide emails'}).uncheck();
    const named=page.locator('.ad-card').first();
    await named.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menu').getByRole('menuitem',{name:'Rename…',exact:true}).click();
    assert.equal(await named.getByLabel('Friendly name',{exact:true}).evaluate(node => node === document.activeElement), true, 'Rename focuses the name editor');
    assert.match(await named.innerText(),/Credential status:.*Active/);
    await named.getByLabel('Friendly name',{exact:true}).fill('Personal Max');
    await named.getByRole('button',{name:'Save name',exact:true}).click();
    assert.equal(await named.locator('h3').innerText(),'Personal Max');
    await page.locator('.ad-display-options').evaluate(node => { node.open = true; });
    await page.getByRole('checkbox',{name:'Hide emails'}).check();
    assert.ok(!(await page.locator('.account-dashboard').innerText()).includes('Personal Max'));
    await page.locator('.ad-display-options').evaluate(node => { node.open = true; });
    await page.getByRole('checkbox',{name:'Hide emails'}).uncheck();
    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Accounts',exact:true}).click();
    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:/^Overview/}).click();
    await page.waitForFunction(()=>!document.querySelector('.quota-refresh')?.disabled);
    await page.getByRole('searchbox',{name:'Search accounts'}).fill('Personal Max');
    assert.equal(await page.locator('.ad-card').count(),1);
    await page.getByRole('searchbox',{name:'Search accounts'}).fill('');

    await page.getByRole('button', {name:'Dark',exact:true}).click();
    if (screenshot) await page.screenshot({path:screenshot.replace('.png','-dark.png'),style:'#browser-mock-toolbar { visibility: hidden; }'});
    await page.getByRole('button', {name:'Light',exact:true}).click();
    for (const width of [1280, 960, 640]) {
      await page.setViewportSize({width,height:1000});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Overflow at ${width}px`);
    }
    if (screenshot) await page.screenshot({path:screenshot.replace('.png','-compact.png'),fullPage:false,style:'#browser-mock-toolbar { visibility: hidden; }'});
    assert.deepEqual(errors, []);
    console.log('PASS: 10 credentials, four summaries, availability counts, 15 aligned Claude limits, five visible rows, isolated refresh, summary expansion, compact layout, light/dark, responsive widths, no browser errors.');
  } finally { await browser?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
