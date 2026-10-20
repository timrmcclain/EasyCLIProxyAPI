const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: every button, select, switch and folding header on the main pages is at least
// 32px tall and 24px wide to click, counting the invisible hit area small-looking controls get. Text links
// inside a sentence are exempt, as WCAG 2.5.8 allows.
const PAGES = ['home', 'oauth', 'api', 'usage-records', 'agents', 'claude-extensions', 'connectors', 'secret-guard', 'jev', 'config', 'health'];
const INLINE_LINKS = ['glance-link', 'home-inline-link'];

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
    const tooSmall = [];
    for (const pageId of PAGES) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(20000);
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript(id => {
        localStorage.setItem('easy-cli-proxy-api.locale', 'en');
        localStorage.setItem('personal.lastPage', id);
      }, pageId);
      await page.goto(`${base}/?mock=running&mockDelay=5`, { timeout: 60000 });
      await page.locator('main h1').first().waitFor({ state: 'attached' });
      await page.waitForFunction(() => !document.querySelector('main [aria-busy="true"]'), null, { timeout: 15000 }).catch(() => {});
      const found = await page.evaluate(exempt => {
        const out = [];
        for (const el of document.querySelectorAll('main button, main select, main [role="switch"], main summary, .sidebar button')) {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (!r.width || !r.height || style.visibility !== 'visible' || style.display === 'inline') continue;
          if (exempt.some(name => el.classList.contains(name))) continue;
          const hit = getComputedStyle(el, '::before');
          const grow = hit.content !== 'none' && hit.position === 'absolute' ? Math.max(0, -parseFloat(hit.top) || 0) * 2 : 0;
          const inputGrow = el.matches('.switch-control input') ? Math.max(0, -parseFloat(style.top) || 0) * 2 : 0;
          const extra = Math.max(grow, inputGrow);
          const height = r.height + extra, width = r.width + extra;
          if (height < 31.5 || width < 24) {
            out.push(`${el.parentElement?.className?.toString().split(' ')[0] ?? ''} > ${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')} ${Math.round(width)}x${Math.round(height)}`);
          }
        }
        return out;
      }, INLINE_LINKS);
      for (const item of found) tooSmall.push(`${pageId}: ${item}`);
      await page.close();
    }
    assert.deepEqual([...new Set(tooSmall)], [], 'controls smaller than 32px to click');
    console.log(`Every control on ${PAGES.length} pages is at least 32px to click.`);
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
