const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// "Use first for an hour": raises one account above the rest of its provider, then puts the old priority back,
// either when you stop early or, if the hub was closed when the hour ran out, on the next start.
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
    const open = async (focus) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
      await page.addInitScript((saved) => {
        localStorage.setItem('easy-cli-proxy-api.locale', 'en');
        localStorage.setItem('personal.lastPage', 'home');
        if (saved) localStorage.setItem('personal.accountFocus', JSON.stringify(saved));
        // Record every priority write the page sends to the proxy.
        window.priorityWrites = [];
        const install = () => {
          const internals = window.__TAURI_INTERNALS__;
          if (!internals?.invoke || internals.invoke.recording) return false;
          const original = internals.invoke;
          internals.invoke = async (command, args, ...rest) => {
            const req = args?.request;
            if (command === 'management_request' && req?.method === 'PATCH' && req.path === '/credentials/fields') {
              const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
              if (body && 'priority' in body) window.priorityWrites.push({ name: body.name, priority: body.priority });
            }
            return original(command, args, ...rest);
          };
          internals.invoke.recording = true;
          return true;
        };
        const timer = setInterval(() => { if (install()) clearInterval(timer); }, 5);
      }, focus);
      await page.goto(`${base}/?mock=running&mockDelay=5`);
      await page.locator('.ad-card').first().waitFor();
      return page;
    };
    const credentials = (page) => page.evaluate(async () => {
      const result = await window.__TAURI_INTERNALS__.invoke('management_request', { request: { method: 'GET', path: '/credentials' } });
      const payload = typeof result === 'string' ? JSON.parse(result) : result;
      return (payload.body ? (typeof payload.body === 'string' ? JSON.parse(payload.body) : payload.body) : payload).files;
    });

    // Start and stop from Overview.
    const page = await open(null);
    const before = await credentials(page);
    const card = page.locator('.ad-card').first();
    await card.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Use first for an hour' }).click();
    const notice = page.locator('.ad-focus');
    await notice.waitFor();
    assert.match(await notice.innerText(), /is used first until .*requests go to your other accounts/);
    const focus = await page.evaluate(() => JSON.parse(localStorage.getItem('personal.accountFocus')));
    const target = before.find(file => file.name === focus.name);
    const rivals = before.filter(file => file.name !== focus.name && (file.provider ?? file.type) === (target.provider ?? target.type) && file.disabled !== true);
    const expected = Math.max(Number(target.priority ?? 0), ...rivals.map(file => Number(file.priority ?? 0) + 1));
    assert.equal(focus.boostedPriority, expected, 'raised just above the rest of its provider');
    assert.equal(focus.originalPriority, Number(target.priority ?? 0));
    assert.ok(focus.until - Date.now() > 59 * 60_000, 'lasts an hour');
    if (expected !== focus.originalPriority) {
      assert.deepEqual(await page.evaluate(() => window.priorityWrites.at(-1)), { name: focus.name, priority: expected });
    }
    await notice.getByRole('button', { name: 'Stop using first' }).click();
    await notice.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => localStorage.getItem('personal.accountFocus')), null);
    const after = await credentials(page);
    assert.equal(Number(after.find(file => file.name === focus.name).priority ?? 0), focus.originalPriority, 'stopping early puts the old priority back');
    await page.close();

    // An hour that ran out while the hub was closed is ended on the next start.
    // A fresh mock starts the account at its fixture priority, so record that as the raised value and a
    // different value as the original: the start-up check must write the original back.
    const current = Number(target.priority ?? 0);
    const expired = { ...focus, boostedPriority: current, originalPriority: current + 7, until: Date.now() - 60_000 };
    const restarted = await open(expired);
    await restarted.waitForFunction(() => localStorage.getItem('personal.accountFocus') === null, null, { timeout: 40_000 });
    const restored = await credentials(restarted);
    assert.equal(Number(restored.find(file => file.name === focus.name).priority ?? 0), current + 7, 'expired hour restored on start');
    assert.equal(await restarted.locator('.ad-focus').count(), 0);
    await restarted.close();

    // If you changed the priority yourself during the hour, the restore leaves your value alone.
    const changed = { ...focus, boostedPriority: current + 3, originalPriority: current + 7, until: Date.now() - 60_000 };
    const untouched = await open(changed);
    await untouched.waitForFunction(() => localStorage.getItem('personal.accountFocus') === null, null, { timeout: 40_000 });
    assert.equal(Number((await credentials(untouched)).find(file => file.name === focus.name).priority ?? 0), current, 'a priority you changed is kept');
    await untouched.close();

    assert.deepEqual(errors, []);
    console.log('PASS: use-first-for-an-hour raises one account, stops early, and is restored after a restart.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
