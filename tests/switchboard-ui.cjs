const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Overview opens on the switchboard: whether requests are getting through, which account each provider is spending,
// the last 24 hours by account, and the week's refills. A lane opens the routing order; an hour opens Activity.
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
    for (const [width, height] of [[1440, 1000], [640, 570]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      page.setDefaultTimeout(20000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript(() => {
        localStorage.setItem('easy-cli-proxy-api.locale', 'en');
        localStorage.setItem('personal.lastPage', 'home');
      });
      await page.goto(`${base}/?mock=running&mockDelay=5`);

      const board = page.locator('.switchboard:not(.sb-history)');
      const history = page.locator('.sb-history');
      await board.waitFor();
      assert.equal(await board.locator('.sb-state').innerText(), 'Working');
      assert.match(await board.locator('.sb-sentence').innerText(), /^Requests are going through\./);
      // The port stays out of the status line unless something is wrong; it's in the tooltip.
      const proxy = page.locator('.home-status-proxy strong');
      assert.equal(await proxy.innerText(), 'Proxy running');
      assert.match(await proxy.getAttribute('title'), /port \d+/);

      // One lane per provider with a choice, each naming the account the next request goes to.
      const claude = board.getByRole('button', { name: /^Claude: next request goes to / });
      await claude.waitFor();
      assert.ok(await board.locator('.sb-lane').count() >= 2);
      assert.ok(await board.locator('.sb-lane-account strong').first().evaluate(node => node.scrollWidth > 40), 'the paying account is named, not truncated away');
      assert.equal(await board.locator('.sb-lane svg.sb-gauge').count(), await board.locator('.sb-lane').count());
      assert.ok(await board.locator('.sb-apps li').count() >= 1, 'apps that sent requests in the last hour are listed');
      assert.match(await board.locator('.sb-apps li').first().innerText(), /\d+ requests?$/);

      // Below the accounts, the 24-hour strip has a bar per hour; an hour with traffic names the account that served most of it.
      await history.locator('.sb-strip-bars').waitFor();
      assert.equal(await history.locator('.sb-strip-hour').count(), 24);
      const busy = history.locator('.sb-strip-hour:not([disabled])').last();
      assert.match(await busy.getAttribute('aria-label'), /: \d+ requests?, most by /);
      assert.ok(await history.locator('.sb-calendar li').count() === 7 || await history.getByText('No weekly refills in the next 7 days.').count() === 1);

      // Nothing on Overview scrolls sideways at either size.
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no sideways scroll at ${width}px`);

      // An hour opens Activity; a lane opens Settings → Routing.
      await busy.click();
      await page.locator('.usage-records-page, [data-page="usage-records"]').first().waitFor();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'home' })));
      await board.waitFor();
      await claude.click();
      await page.locator('#config-routing-order .routing-order').waitFor();
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log('PASS: the switchboard says whether requests get through, who pays per provider, who served each hour, and links to the order and Activity.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
