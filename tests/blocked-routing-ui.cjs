const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// An account the provider refuses (terms to accept) moves below the provider's other accounts so requests go there;
// its notice says so, and "I've fixed it" puts the old priority back without the old refusal moving it down again.
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => route.request().url().startsWith(`${base}/`) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'oauth');
      // A second Claude account that has only ever been refused for unaccepted terms.
      globalThis.mockExtraAuthFiles = [{
        name: 'claude-new.json', provider: 'claude', type: 'anthropic', source: 'file', path: 'C:\\EasyCLIProxyAPI\\oauth\\claude-new.json',
        auth_index: 'mock-claude-2', email: 'new.mock@example.com', disabled: false, priority: 10, success: 0, failed: 3,
        modtime: Date.now() - 60_000, excluded_models: [],
      }];
      globalThis.mockExtraUsageEvents = [{
        id: 'terms-1', row_id: 'terms-1', timestamp: new Date(Date.now() - 60_000).toISOString(), latency_ms: 200, ttft_ms: null,
        auth_index: 'mock-claude-2', user_agent: 'claude-cli/2.1', source: 'claude-code', source_display: 'Claude Code',
        failed: true, canceled: false, failure_status: 400,
        failure_body: '{"type":"error","error":{"type":"invalid_request_error","message":"We\'ve updated our Consumer Terms and Privacy Policy. You\'ll need to accept them to continue."}}',
        provider: 'claude', model: 'claude-sonnet-4-6', input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 0,
      }];
      window.priorityWrites = [];
      const timer = setInterval(() => {
        const internals = window.__TAURI_INTERNALS__;
        if (!internals?.invoke || internals.invoke.recording) return;
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
        clearInterval(timer);
      }, 5);
    });
    await page.goto(`${base}/?mock=running&mockDelay=5`);

    // The background check moves the refused account just below the other Claude account (priority 0).
    await page.waitForFunction(() => window.priorityWrites.some(write => write.name === 'claude-new.json'));
    assert.deepEqual(await page.evaluate(() => window.priorityWrites), [{ name: 'claude-new.json', priority: -1 }]);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('personal.blockedRouting')));
    assert.deepEqual({ ...saved.demoted['claude-new.json'], since: 0 }, { provider: 'claude', originalPriority: 10, demotedPriority: -1, kind: 'terms', since: 0 });

    // Its notice says where requests go, and offers to use it again.
    const notice = page.locator('.quota-availability').filter({ has: page.locator('.quota-routed-away') });
    await notice.first().waitFor();
    assert.match(await notice.first().innerText(), /Requests go to this provider’s other accounts until this is fixed/);
    await notice.first().getByRole('button', { name: /fixed it, use it again/ }).click();
    await page.getByText(/Back in normal use/).first().waitFor();
    assert.deepEqual((await page.evaluate(() => window.priorityWrites)).at(-1), { name: 'claude-new.json', priority: 10 });
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('personal.blockedRouting')));
    assert.deepEqual(after.demoted, {});
    assert.ok(after.released['claude-new.json'] > 0, 'the release time is kept so the old refusal no longer counts');

    assert.deepEqual(errors, []);
    console.log('PASS: a refused account moves below its provider\'s other accounts, says so, and can be put back in use.');
  } finally { await browser?.close(); await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
