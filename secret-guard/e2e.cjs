// End-to-end check of the Secret Guard plugin inside a real proxy binary.
//
//   node secret-guard/e2e.cjs <path to cli-proxy-api.exe>
//
// Copies the proxy into a throwaway folder with its own config on port 18317,
// loads the freshly built plugin, and sends requests through it to a fake
// upstream on port 18318 that records what it receives. The installed proxy is
// only read, never started or changed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const assert = require('assert/strict');

const proxyExe = process.argv[2];
if (!proxyExe || !fs.existsSync(proxyExe)) {
  console.error('usage: node secret-guard/e2e.cjs <path to cli-proxy-api.exe>');
  process.exit(2);
}
const dll = path.join(__dirname, 'target', 'release', process.platform === 'win32' ? 'secret_guard.dll' : 'libsecret_guard.so');
assert.ok(fs.existsSync(dll), `build the plugin first: ${dll}`);

const PORT = 18317;
const UPSTREAM = 18318;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'e2e-key';
const MGMT = 'e2e-management';
// Assembled at runtime so no token-shaped literal sits in this file.
const TOKEN = 'gh' + 'p_' + 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xYz9Ab';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-guard-e2e-'));
const slash = p => p.replace(/\\/g, '/');
const pluginDir = path.join(dir, 'plugins', process.platform === 'win32' ? 'windows' : process.platform, 'amd64');
fs.mkdirSync(pluginDir, { recursive: true });
fs.mkdirSync(path.join(dir, 'auth'));
fs.copyFileSync(dll, path.join(pluginDir, process.platform === 'win32' ? 'secret-guard.dll' : 'secret-guard.so'));
const exe = path.join(dir, path.basename(proxyExe));
fs.copyFileSync(proxyExe, exe);
const findingsFile = path.join(dir, 'findings.jsonl');
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
api-keys:
  openai-compatibility:
    - name: "fake"
      base-url: "http://127.0.0.1:${UPSTREAM}/v1"
      keys:
        - api-key: "fake-upstream"
      models:
        - { name: "fake-model", alias: "gpt-e2e" }
        - { name: "fake-model", alias: "claude-e2e" }
        - { name: "fake-model", alias: "grok-e2e" }
plugins:
  enabled: true
  dir: "plugins"
  configs:
    secret-guard:
      enabled: true
      priority: 100
      default_mode: report
      modes: { openai: redact, xai: block }
      findings_file: "${slash(findingsFile)}"
      salt: "e2e-salt"
`);

const received = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    received.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'fake-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const findings = () => fs.existsSync(findingsFile) ? fs.readFileSync(findingsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

async function post(route, body) {
  const started = performance.now();
  const res = await fetch(BASE + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-api-key': KEY, 'user-agent': 'e2e-test/1.0' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), ms: performance.now() - started };
}

const formats = {
  chat: model => ['/v1/chat/completions', { model, messages: [{ role: 'user', content: `deploy with ${TOKEN} please` }] }],
  messages: model => ['/v1/messages', { model, max_tokens: 16, messages: [{ role: 'user', content: `deploy with ${TOKEN} please` }] }],
  responses: model => ['/v1/responses', { model, input: `deploy with ${TOKEN} please` }],
};

let proxy;
(async () => {
  await new Promise(resolve => upstream.listen(UPSTREAM, '127.0.0.1', resolve));
  proxy = spawn(exe, ['-config', path.join(dir, 'config.yaml')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proxy.stdout.on('data', chunk => { log += chunk; });
  proxy.stderr.on('data', chunk => { log += chunk; });
  for (let i = 0; i < 60; i++) {
    if (log.includes('plugin registered plugin_id=secret-guard')) break;
    if (log.includes('secret-guard returned invalid')) throw new Error('the proxy rejected the plugin registration');
    await wait(250);
  }
  assert.ok(log.includes('plugin registered plugin_id=secret-guard'), `plugin didn't register:\n${log.slice(-2000)}`);
  const lines = ['plugin loads and registers'];

  for (const [format, build] of Object.entries(formats)) {
    let before = received.length;
    let r = await post(...build('claude-e2e'));
    assert.equal(received.length, before + 1, `${format}/report reached upstream (${r.status}: ${r.text.slice(0, 200)})`);
    assert.ok(received.at(-1).includes(TOKEN), `${format}/report: body unchanged`);

    before = received.length;
    r = await post(...build('gpt-e2e'));
    assert.equal(received.length, before + 1, `${format}/redact reached upstream (${r.status})`);
    assert.ok(!received.at(-1).includes(TOKEN), `${format}/redact: token removed`);
    assert.match(received.at(-1), /\[REDACTED:github_token:[0-9a-f]{8}\]/, `${format}/redact: placeholder`);

    before = received.length;
    r = await post(...build('grok-e2e'));
    assert.equal(received.length, before, `${format}/block: nothing sent upstream`);
    assert.equal(r.status, 400, `${format}/block: status`);
    assert.ok(r.text.includes('Secret Guard blocked this request') && !r.text.includes(TOKEN), `${format}/block: message`);
    lines.push(`${format}: report passes through, redact replaces, block refuses`);
  }

  const placeholders = new Set(received.flatMap(body => body.match(/\[REDACTED:[a-z_]+:[0-9a-f]{8}\]/g) ?? []));
  assert.equal(placeholders.size, 1, 'the placeholder is identical in every format');
  assert.ok(!fs.readFileSync(findingsFile, 'utf8').includes(TOKEN), 'findings never contain the secret');
  const actions = [...new Set(findings().map(f => `${f.provider}:${f.action}`))].sort();
  assert.deepEqual(actions, ['anthropic:reported', 'openai:redacted', 'xai:blocked']);
  lines.push(`findings: ${actions.join(', ')}; secret never written`);

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${MGMT}` };
  let res = await fetch(`${BASE}/v0/management/plugins/secret-guard/enabled`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) });
  assert.ok(res.ok, `switch off: ${res.status}`);
  await wait(1500);
  assert.equal((await post(...formats.chat('grok-e2e'))).status, 200, 'switched off: nothing is blocked');
  res = await fetch(`${BASE}/v0/management/plugins/secret-guard/enabled`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: true }) });
  assert.ok(res.ok, `switch on: ${res.status}`);
  await wait(1500);
  assert.equal((await post(...formats.chat('grok-e2e'))).status, 400, 'switched on again: blocking resumes');
  lines.push('switching off and on through the management API works without a restart');

  const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(46000);
  const timings = [];
  for (let i = 0; i < 6; i++) timings.push((await post('/v1/chat/completions', { model: 'claude-e2e', messages: [{ role: 'user', content: filler }] })).ms);
  timings.sort((a, b) => a - b);
  lines.push(`2 MB request through the proxy: ${timings[3].toFixed(0)} ms median`);

  console.log(lines.map(line => `  ✓ ${line}`).join('\n'));
})()
  .catch(error => { console.error(`secret-guard e2e FAILED: ${error.message}`); process.exitCode = 1; })
  .finally(async () => {
    if (proxy) proxy.kill();
    upstream.close();
    await wait(1000);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the proxy may still hold the DLL for a moment */ }
  });
