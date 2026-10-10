// Runs the browser (Playwright) tests with everything they need: finds Playwright, starts the
// dev servers that fixture tests expect on fixed ports, runs the tests, stops what it started.
//
//   bun scripts/run-ui-tests.mjs                 # every tests/*-ui.cjs
//   bun scripts/run-ui-tests.mjs home quota      # only files whose name contains "home" or "quota"
//
// Tests that start their own server on one of those ports run first, before the shared servers start.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PORTS = [1421, 1422, 1423];
const TIMEOUT_MS = 300_000;

function findPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE && existsSync(process.env.PLAYWRIGHT_MODULE)) return process.env.PLAYWRIGHT_MODULE;
  const require = createRequire(path.join(root, 'package.json'));
  try { return path.dirname(require.resolve('playwright/package.json')); } catch { /* not a dependency */ }
  // npx caches (where `npx playwright` puts it) and the global npm folder.
  const roots = [
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.npm'), 'npm-cache', '_npx'),
    path.join(os.homedir(), '.npm', '_npx'),
  ];
  for (const base of roots) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const candidate = path.join(base, entry, 'node_modules', 'playwright');
      if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
  }
  const globalRoot = path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'playwright');
  if (existsSync(globalRoot)) return globalRoot;
  throw new Error('Playwright not found. Install it with: npx playwright install msedge');
}

const listening = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

async function startServers() {
  const imp = (name) => import(pathToFileURL(createRequire(path.join(root, 'package.json')).resolve(name)).href);
  const { createServer } = await imp('vite');
  const react = (await imp('@vitejs/plugin-react')).default;
  const started = [];
  for (const port of FIXTURE_PORTS) {
    if (await listening(port)) continue;
    const server = await createServer({ configFile: false, root, plugins: [react()], logLevel: 'error',
      server: { host: '127.0.0.1', port, strictPort: true, watch: null } });
    await server.listen();
    // Warm the first page load so tests with short timeouts don't race the initial compile.
    await fetch(`http://127.0.0.1:${port}/`).catch(() => {});
    started.push(server);
  }
  return started;
}

function runTest(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [file], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); output += `\nTimed out after ${TIMEOUT_MS / 1000}s`; }, TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output }); });
  });
}

const filters = process.argv.slice(2);
const files = readdirSync(path.join(root, 'tests'))
  .filter((name) => name.endsWith('-ui.cjs') && (!filters.length || filters.some((filter) => name.includes(filter))))
  .sort()
  .map((name) => path.join('tests', name));

// A test that passes `port: 142x` to its own createServer needs that port free.
const ownsFixturePort = (file) => {
  const source = readFileSync(path.join(root, file), 'utf8');
  return FIXTURE_PORTS.some((port) => new RegExp(String.raw`port:\s*${port}\b`).test(source));
};
const selfHosted = files.filter(ownsFixturePort);
const shared = files.filter((file) => !ownsFixturePort(file));

const env = { ...process.env, PLAYWRIGHT_MODULE: findPlaywright() };
const failures = [];
async function runAll(list) {
  for (const file of list) {
    const started = Date.now();
    let result = await runTest(file, env);
    // One retry absorbs a cold first compile. Retried passes are labelled so flakiness stays visible.
    const retried = result.code !== 0;
    if (retried) result = await runTest(file, env);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${result.code === 0 ? (retried ? 'pass (after retry)' : 'pass') : 'FAIL'}  ${file}  ${seconds}s`);
    if (result.code !== 0) failures.push({ file, output: result.output });
  }
}

await runAll(selfHosted);
const servers = shared.length ? await startServers() : [];
try {
  await runAll(shared);
} finally {
  await Promise.all(servers.map((server) => server.close()));
}

for (const { file, output } of failures) {
  console.log(`\n--- ${file}\n${output.split('\n').filter((line) => !/^\s+at /.test(line)).slice(-25).join('\n')}`);
}
console.log(`\n${files.length - failures.length} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
