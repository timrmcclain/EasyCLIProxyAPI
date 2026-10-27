// End-to-end check of the App Routing plugin inside a real proxy binary.
//
//   node app-routing/e2e.cjs <path to cli-proxy-api.exe>
//
// Copies the proxy into a throwaway folder with its own config on port 18337 and two fake Kimi accounts whose
// requests go to a fake upstream on port 18338, which records which account's token each request carried. Kimi is
// used because its account files may name their own server. The installed proxy is only read, never started or
// changed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert/strict');

const proxyExe = process.argv[2];
if (!proxyExe || !fs.existsSync(proxyExe)) {
  console.error('usage: node app-routing/e2e.cjs <path to cli-proxy-api.exe>');
  process.exit(2);
}
const dll = path.join(__dirname, 'target', 'release', process.platform === 'win32' ? 'app_routing.dll' : 'libapp_routing.so');
assert.ok(fs.existsSync(dll), `build the plugin first: ${dll}`);

const PORT = 18337;
const UPSTREAM = 18338;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'e2e-key';
const MGMT = 'e2e-management';
const DESKTOP = 'claude-cli/2.1.0 (claude-desktop-3p)';
const CODE = 'claude-cli/2.1.0 (external, cli)';
const CODEX = 'codex_cli_rs/0.50.0';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-routing-e2e-'));
const slash = p => p.replace(/\\/g, '/');
const pluginDir = path.join(dir, 'plugins', process.platform === 'win32' ? 'windows' : process.platform, 'amd64');
fs.mkdirSync(pluginDir, { recursive: true });
fs.mkdirSync(path.join(dir, 'auth'));
fs.copyFileSync(dll, path.join(pluginDir, process.platform === 'win32' ? 'app-routing.dll' : 'app-routing.so'));
// kimi-a is first in the routing order (higher priority), kimi-b second.
for (const [name, token, priority] of [['kimi-a@e2e.test.json', 'token-a', 20], ['kimi-b@e2e.test.json', 'token-b', 10]]) {
  fs.writeFileSync(path.join(dir, 'auth', name), JSON.stringify({
    type: 'kimi', access_token: token, refresh_token: 'unused', expired: '2099-01-01T00:00:00Z',
    email: name.replace(/\.json$/, ''), base_url: `http://127.0.0.1:${UPSTREAM}`, priority,
  }));
}
const exe = path.join(dir, path.basename(proxyExe));
fs.copyFileSync(proxyExe, exe);
fs.writeFileSync(path.join(dir, 'config.yaml'), `config-version: 8
server:
  host: "127.0.0.1"
  port: ${PORT}
management:
  secret-key: "${MGMT}"
access:
  api-keys: ["${KEY}"]
oauth:
  auth-dir: "${slash(path.join(dir, 'auth'))}"
plugins:
  enabled: true
  dir: "plugins"
  configs:
    app-routing:
      enabled: true
      priority: 100
      rules:
        claude-desktop: { accounts: ["kimi-b@e2e.test.json"], providers: ["kimi"] }
        codex: { accounts: ["not-an-account.json"], providers: ["kimi"], only: true }
`);

const tokens = [];
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    tokens.push(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'kimi-k2', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const management = { 'content-type': 'application/json', authorization: `Bearer ${MGMT}` };

/** Sends one request as `userAgent` and returns which account paid for it (`a`, `b`) or the refusal. */
async function ask(userAgent, session) {
  const before = tokens.length;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'user-agent': userAgent };
  if (session) headers['x-claude-code-session-id'] = session;
  const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'kimi-k2', messages: [{ role: 'user', content: 'hi' }] }) });
  const text = await res.text();
  if (tokens.length === before) return { status: res.status, text };
  return { status: res.status, account: tokens.at(-1).replace(/^token-/, '') };
}

async function setRules(rules) {
  const res = await fetch(`${BASE}/v8/management/config/plugins/configs/app-routing`, {
    method: 'PUT', headers: management, body: JSON.stringify({ enabled: true, priority: 100, rules }),
  });
  assert.ok(res.ok, `rules write: ${res.status} ${await res.text()}`);
  await wait(1500);
}

async function setDisabled(name, disabled) {
  const res = await fetch(`${BASE}/v8/management/credentials/status`, { method: 'PATCH', headers: management, body: JSON.stringify({ name, disabled }) });
  assert.ok(res.ok, `${disabled ? 'disable' : 'enable'} ${name}: ${res.status} ${await res.text()}`);
  await wait(800);
}

let proxy;
(async () => {
  await new Promise(resolve => upstream.listen(UPSTREAM, '127.0.0.1', resolve));
  proxy = spawn(exe, ['-config', path.join(dir, 'config.yaml')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proxy.stdout.on('data', chunk => { log += chunk; });
  proxy.stderr.on('data', chunk => { log += chunk; });
  for (let i = 0; i < 60 && !log.includes('plugin registered plugin_id=app-routing'); i++) await wait(250);
  assert.ok(log.includes('plugin registered plugin_id=app-routing'), `plugin didn't register:\n${log.slice(-2000)}`);
  let listening = false;
  for (let i = 0; i < 60 && !listening; i++) {
    listening = await fetch(`${BASE}/`).then(() => true, () => false);
    if (!listening) await wait(250);
  }
  assert.ok(listening, `the proxy never started answering on ${BASE}:\n${log.slice(-2000)}`);
  await wait(1000);
  const lines = ['plugin loads and registers as a scheduler'];

  // The app name reaches the plugin: Claude Desktop is given its own account, below the top of the order.
  assert.equal((await ask(DESKTOP)).account, 'b', 'Claude Desktop uses its account');
  assert.equal((await ask(DESKTOP)).account, 'b', 'and keeps using it');
  assert.equal((await ask(CODE)).account, 'a', 'an app without a rule gets the normal first account');
  lines.push('Claude Desktop is routed to its account; Claude Code, with no rule, gets the top of the order');

  const refused = await ask(CODEX);
  assert.equal(refused.account, undefined, 'Only: nothing sent upstream');
  assert.ok(refused.status >= 400 && refused.text.includes('App Routing is set to use only those accounts'), `Only refusal: ${refused.status} ${refused.text}`);
  lines.push('an Only rule with none of its accounts available refuses, and spends nothing');

  // Rules change live, through the management API, without a restart.
  await setRules({ 'claude-desktop': { accounts: ['kimi-a@e2e.test.json', 'kimi-b@e2e.test.json'], providers: ['kimi'] } });
  // A conversation that starts while kimi-a is off lands on kimi-b...
  await setDisabled('kimi-a@e2e.test.json', true);
  assert.equal((await ask(DESKTOP, 'conversation-1')).account, 'b', 'started on b while a was off');
  await setDisabled('kimi-a@e2e.test.json', false);
  // ...and stays there once kimi-a is back, while a new conversation takes the top account.
  assert.equal((await ask(DESKTOP, 'conversation-1')).account, 'b', 'the conversation stays on b');
  assert.equal((await ask(DESKTOP, 'conversation-2')).account, 'a', 'a new conversation gets a');
  assert.equal((await ask(DESKTOP, 'conversation-1')).account, 'b', 'still b');
  lines.push('rule changes apply without a restart; a conversation stays on its account while a new one takes the top');

  // Prefer: when none of the app's accounts are available, the proxy routes it as usual.
  await setRules({ 'claude-desktop': { accounts: ['kimi-b@e2e.test.json'], providers: ['kimi'] } });
  await setDisabled('kimi-b@e2e.test.json', true);
  assert.equal((await ask(DESKTOP)).account, 'a', 'Prefer falls back to the normal order');
  await setDisabled('kimi-b@e2e.test.json', false);
  lines.push('Prefer falls back to the normal order when the app has no account left');

  // Switched off: every app routes normally again.
  // The same call the hub's switch makes.
  const res = await fetch(`${BASE}/v8/management/config/plugins/configs/app-routing/enabled`, { method: 'PUT', headers: management, body: JSON.stringify(false) });
  assert.ok(res.ok, `switch off: ${res.status}`);
  await wait(1500);
  assert.equal((await ask(DESKTOP)).account, 'a', 'switched off: Claude Desktop gets the normal first account');
  lines.push('switching the plugin off returns every app to the normal order');

  console.log(lines.map(line => `  ✓ ${line}`).join('\n'));
})()
  .catch(error => { console.error(`app-routing e2e FAILED: ${error.message}`); process.exitCode = 1; })
  .finally(async () => {
    if (proxy) proxy.kill();
    upstream.close();
    await wait(1000);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the proxy may still hold the DLL for a moment */ }
  });
