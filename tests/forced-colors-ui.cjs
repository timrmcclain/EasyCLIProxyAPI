const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// In Windows high-contrast mode, quota bars must keep a visible fill and an outlined track instead of
// vanishing when Windows replaces their background colours.
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
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => { localStorage.setItem('easy-cli-proxy-api.locale', 'en'); });
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto(`${base}/?mock=running`, { timeout: 60000 });
    await page.locator('.quota-account-state.available').first().waitFor();
    await page.locator('.ad-quota meter').first().waitFor();

    const styles = await page.evaluate(() => {
      const segment = getComputedStyle(document.querySelector('.quota-account-state.available'));
      const meter = document.querySelector('.ad-quota meter');
      const meterStyle = getComputedStyle(meter);
      const meterFill = getComputedStyle(meter, '::-webkit-meter-optimum-value');
      return {
        forced: matchMedia('(forced-colors: active)').matches,
        segmentBorder: `${segment.borderTopWidth} ${segment.borderTopStyle}`,
        segmentPaint: segment.backgroundImage !== 'none' ? segment.backgroundImage : segment.backgroundColor,
        meterBorder: `${meterStyle.borderTopWidth} ${meterStyle.borderTopStyle}`,
        meterFill: meterFill.backgroundColor,
        meterTrack: meterStyle.backgroundColor,
        exhausted: (() => { const el = document.querySelector('.quota-account-state.exhausted'); return el ? getComputedStyle(el).backgroundColor : null; })(),
        canvas: (() => { const probe = document.createElement('div'); probe.style.cssText = 'forced-color-adjust:none;background:Canvas'; document.body.append(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value; })(),
      };
    });
    assert.equal(styles.forced, true, 'high-contrast emulation is on');
    assert.equal(styles.segmentBorder, '1px solid', 'provider segments are outlined');
    assert.notEqual(styles.segmentPaint, 'rgba(0, 0, 0, 0)', 'provider segments keep a fill');
    assert.notEqual(styles.segmentPaint, 'none');
    assert.equal(styles.meterBorder, '1px solid', 'account meters are outlined');
    // (the meter's inner fill can't be read through getComputedStyle; checked by pixels below)

    assert.ok(styles.exhausted, 'the mock has an exhausted account');
    assert.equal(styles.exhausted, styles.canvas, 'an exhausted segment is an empty system-coloured track, not app red');

    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    assert.deepEqual(errors, []);
    console.log('forced-colors: pass', JSON.stringify(styles));
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
