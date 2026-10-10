const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

// Against the browser mock: Advanced tools → Skills & plugins lists plugins and skills, installs a
// plugin switched off for review, shows a marketplace command before running it, and adds and
// removes skills with confirmation.
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      localStorage.setItem('easy-cli-proxy-api.locale', 'en');
      localStorage.setItem('personal.lastPage', 'home');
    });
    const dialog = () => page.locator('[role="dialog"], [role="alertdialog"]').last();
    const confirm = async (pattern, button) => {
      await dialog().waitFor();
      assert.match(await dialog().innerText(), pattern);
      await dialog().getByRole('button', { name: button, exact: true }).click();
      await dialog().waitFor({ state: 'detached' });
    };

    await page.goto(`${base}/?mock=running`, { timeout: 60000 });
    await page.locator('.personal-advanced summary').click();
    // The proxy's own plugins page is renamed so the two aren't confused.
    await page.getByRole('button', { name: 'Proxy plugins', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Skills & plugins', exact: true }).click();
    await page.getByRole('heading', { name: 'Skills & plugins', exact: true }).waitFor();

    // Installed plugins: counts leave out the session-only plugin, which gets no buttons.
    const plugins = page.locator('section[aria-labelledby="ext-plugins-title"]');
    await plugins.locator('.ext-row').first().waitFor();
    assert.match(await plugins.locator('.jev-counts').innerText(), /1 on · 3 installed/);
    const sessionRow = plugins.locator('.ext-row', { hasText: 'jev-panel' });
    assert.match(await sessionRow.innerText(), /This session only/);
    assert.equal(await sessionRow.getByRole('button').count(), 0);
    assert.match(await plugins.locator('.ext-row', { hasText: 'typesafe' }).innerText(), /One project.*Crestbid/s);

    // Contents expand from Claude Code's own `plugin details` output.
    const superpowers = plugins.locator('.ext-row', { hasText: 'superpowers' });
    await superpowers.getByRole('button', { name: 'Contents' }).click();
    assert.match(await superpowers.locator('.ext-details').innerText(), /Component inventory/);

    // Switching a plugin on.
    await page.getByRole('switch', { name: 'Switch github on or off' }).check();
    await page.waitForFunction(() => document.querySelector('section[aria-labelledby="ext-plugins-title"] .jev-counts')?.textContent?.includes('2 on'));

    // Searching the marketplace leaves installed plugins out.
    const search = page.getByRole('searchbox', { name: /Search 3 plugins/ });
    await search.fill('docs');
    assert.equal(await plugins.locator('.ext-row', { hasText: 'context7' }).count(), 1);
    assert.equal(await plugins.locator('.ext-row', { hasText: 'code-review' }).count(), 0);
    await search.fill('');

    // Install: confirm, it installs switched off, and the review offers Turn on or Remove.
    await plugins.locator('.ext-row', { hasText: 'code-review' }).getByRole('button', { name: 'Install' }).click();
    await confirm(/installs switched off/, 'Install');
    const review = page.locator('.ext-review');
    await review.waitFor();
    assert.match(await review.innerText(), /Review code-review.*switched off.*Component inventory/s);
    assert.match(await plugins.locator('.ext-row', { hasText: 'code-review' }).first().innerText(), /Off/);
    await review.getByRole('button', { name: 'Turn on' }).click();
    await review.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('section[aria-labelledby="ext-plugins-title"] .jev-counts')?.textContent?.includes('3 on'));

    // A marketplace that installs by running a command shows the command; declining installs nothing.
    await plugins.locator('.ext-row', { hasText: 'npx-tool' }).getByRole('button', { name: 'Install' }).click();
    await dialog().waitFor();
    await dialog().getByRole('button', { name: 'Install', exact: true }).click();
    // The command warning replaces the first dialog straight away.
    await page.getByText('npx -y @example/npx-tool install').waitFor();
    assert.match(await dialog().innerText(), /runs a command to install.*npx -y @example\/npx-tool install.*Only continue if you trust it/s);
    await dialog().getByRole('button', { name: 'Cancel' }).click();
    await dialog().waitFor({ state: 'detached' });
    assert.equal(await page.locator('.ext-review').count(), 0);
    assert.match(await plugins.locator('.jev-counts').innerText(), /4 installed/);

    // Removing a plugin asks first.
    await plugins.locator('.ext-row', { hasText: 'code-review' }).first().getByRole('button', { name: 'Remove' }).click();
    await confirm(/Remove the plugin code-review/, 'Remove');
    await page.waitForFunction(() => document.querySelector('section[aria-labelledby="ext-plugins-title"] .jev-counts')?.textContent?.includes('3 installed'));

    // Skills: scripts are called out; linked folders and non-skills can't be removed.
    const skills = page.locator('section[aria-labelledby="ext-skills-title"]');
    assert.match(await skills.locator('.jev-counts').innerText(), /3 skills in/);
    assert.match(await skills.locator('.ext-skills .ext-row', { hasText: 'pdf' }).innerText(), /Runs scripts: scripts\/fill_form\.py, scripts\/extract\.py/);
    assert.match(await skills.locator('.ext-skills .ext-row', { hasText: 'synced' }).innerText(), /1 file · 4 KB/);
    for (const folder of ['hyperframes-registry', 'synced']) {
      assert.equal(await skills.locator('.ext-skills .ext-row', { hasText: folder }).getByRole('button').count(), 0, folder);
    }

    // Adding a skill: a bad source is refused; a preview shows scripts and existing skills before installing.
    const source = page.getByRole('textbox', { name: 'Add a skill from GitHub' });
    await source.fill('not a repo');
    await skills.getByRole('button', { name: 'Preview' }).click();
    assert.match(await page.locator('.ext-page [role="alert"]').innerText(), /Enter a GitHub repository/);
    await source.fill('anthropics/skills');
    await skills.getByRole('button', { name: 'Preview' }).click();
    const preview = page.locator('.ext-preview');
    await preview.waitFor();
    assert.match(await preview.innerText(), /anthropics\/skills contains 2 skill.*Only install skills from sources you trust/s);
    assert.match(await preview.locator('.ext-row', { hasText: 'slides' }).innerText(), /Runs scripts: scripts\/render\.js/);
    assert.match(await preview.locator('.ext-row', { hasText: 'pdf' }).innerText(), /Already installed/);
    await preview.locator('.ext-row', { hasText: 'slides' }).getByRole('button', { name: 'Install' }).click();
    await preview.locator('.ext-row', { hasText: 'slides' }).getByRole('button', { name: 'Installed' }).waitFor();
    await preview.getByRole('button', { name: 'Done' }).click();
    assert.match(await skills.locator('.jev-counts').innerText(), /4 skills in/);

    // Removing a skill goes to the Recycle Bin after confirmation.
    await skills.locator('.ext-skills .ext-row', { hasText: 'brainstorming' }).getByRole('button', { name: 'Remove' }).click();
    await confirm(/Move the skill brainstorming to the Recycle Bin/, 'Remove');
    await page.waitForFunction(() => document.querySelector('section[aria-labelledby="ext-skills-title"] .jev-counts')?.textContent?.startsWith('3 skills'));

    if (process.env.EXT_SCREENSHOT) await page.screenshot({ path: process.env.EXT_SCREENSHOT, fullPage: true });
    assert.deepEqual(errors, []);
    console.log('claude-extensions-ui: ok');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
