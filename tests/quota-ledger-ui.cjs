const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const server = await createServer({ root: path.resolve(__dirname, '..'), configFile: false, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 1427, strictPort: true } });
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
    await page.waitForFunction(() => !document.querySelector('.quota-refresh').disabled && document.querySelector('.ad-healthy-toggle'));
    // Healthy accounts collapse behind a toggle by default; show them all for the density checks.
    await page.locator('.ad-healthy-toggle').getByRole('button', { name: 'Show all', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.ad-card').length === 10);
    assert.equal(await page.locator('.quota-provider-summary-cell').count(), 4);
    assert.match(await page.locator('.quota-provider-summary-cell').filter({ hasText: 'Grok' }).innerText(), /Remaining quota not reported/);
    assert.equal(await page.locator('.quota-provider-summary-cell').first().locator('.quota-summary-value').innerText(), '5');
    assert.ok((await page.locator('.quota-provider-summary-cell').first().innerText()).includes('of 5 accounts clear'));
    assert.equal(await page.locator('.quota-provider-summary-cell').nth(1).locator('.quota-summary-value').innerText(), '3');
    const claude = page.locator('.quota-account-group').first();
    assert.equal(await claude.locator('.ad-card').count(), 5);
    // The aligned three-limit ledger is an opt-in layout; compact one-row cards are the default.
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
    await claude.locator('.ad-card').first().getByText(/Quota unavailable/).waitFor();
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
    await page.waitForFunction(() => document.querySelector('.quota-account-group .ad-card .ad-account-details > summary')?.title === '1 more limits');
    assert.equal(await moreLimits.locator('span[aria-hidden="true"]').innerText(), '+1', 'Extra limits collapse into a +N chevron');
    await moreLimits.click();
    await claude.locator('.ad-card').first().getByText('Extra usage', {exact:true}).waitFor();
    assert.equal(await claude.locator('.ad-card').first().locator('.ad-quota').count(), 4);
    await moreLimits.click();
    await page.locator('.quota-provider-summary-cell').first().getByRole('button', {name:'Show',exact:true}).click();
    assert.equal(await page.locator('.quota-summary-breakdown').count(), 1);
    await page.locator('.quota-provider-summary-cell').first().getByRole('button', {name:'Hide',exact:true}).click();
    // Both layouts are one-row cards; compact shows only the deciding limit instead of three aligned columns.
    assert.equal(await claude.locator('.ad-card').first().locator('.ad-row-quota .ad-quota').count(), 3);
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
    await page.getByRole('button', {name:'Claude 5',exact:true}).click();
    await page.getByLabel('All states', {exact:true}).selectOption('attention');
    await page.getByRole('navigation', {name:'Main navigation'}).getByRole('button', {name:'Accounts',exact:true}).click();
    // While an account is exhausted, Overview carries a red attention dot (part of its accessible name).
    const overviewNav = page.getByRole('navigation', {name:'Main navigation'}).getByRole('button', {name:/^Overview/});
    assert.equal(await overviewNav.locator('.nav-attention-dot').count(), 1, 'Overview flags the limited account');
    await overviewNav.click();
    await page.waitForFunction(() => !document.querySelector('.quota-refresh')?.disabled);
    assert.equal(await page.getByRole('button', {name:'Claude 5',exact:true}).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('All states', {exact:true}).inputValue(), 'attention');
    await page.getByRole('searchbox', {name:'Search accounts'}).fill('no-such-account');
    await page.getByText('No accounts match these filters', {exact:true}).waitFor();
    assert.equal(await page.locator('.quota-result-count').innerText(), 'Account list: 0 of 10');
    await page.locator('.quota-no-results').getByRole('button', {name:'Clear filters',exact:true}).click();
    assert.equal(await page.locator('.ad-card').count(), 10);
    assert.equal(await page.locator('.quota-result-count').innerText(), 'Account list: 10 of 10');
    await page.getByRole('searchbox', {name:'Search accounts'}).fill('  claude-account-01  ');
    assert.equal(await page.locator('.ad-card').count(), 1);
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
    await page.getByRole('checkbox', {name:'Hide emails'}).uncheck();
    const named=page.locator('.ad-card').first();
    await named.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menu').getByRole('menuitem',{name:'Rename…',exact:true}).click();
    assert.equal(await named.getByLabel('Friendly name',{exact:true}).evaluate(node => node === document.activeElement), true, 'Rename focuses the name editor');
    assert.match(await named.innerText(),/Credential status:.*Active/);
    await named.getByLabel('Friendly name',{exact:true}).fill('Personal Max');
    await named.getByRole('button',{name:'Save name',exact:true}).click();
    assert.equal(await named.locator('h3').innerText(),'Personal Max');
    await page.getByRole('checkbox',{name:'Hide emails'}).check();
    assert.ok(!(await page.locator('.account-dashboard').innerText()).includes('Personal Max'));
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
