/** A plain-text snapshot of the hub's state for pasting into a bug report or a chat. Holds no keys or tokens, and masks
 * anything that looks like an email address or a long secret, so it is safe to share. */

export type DiagnosticAccount = { provider: string; state: string; disabled: boolean };
export type DiagnosticApp = { name: string; installed: boolean; state: string; connectionMatches?: boolean };

export type DiagnosticInput = {
  generatedAt: Date;
  hubVersion: string;
  platform: string;
  proxy: { running: boolean; ready: boolean; version: string | null; managed: boolean };
  host: string;
  allowLan: boolean;
  keyCount: number;
  checks: { level: string; text: string }[];
  accounts: DiagnosticAccount[];
  apps: DiagnosticApp[];
  compression: { enabled: boolean; running: boolean } | null;
};

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** Long unbroken runs of key-like characters: API keys, tokens, session IDs. */
const SECRET = /\b(?:sk-|ak-|eyJ)?[A-Za-z0-9_-]{32,}\b/g;

export function redact(text: string): string {
  return text.replace(EMAIL, '<email>').replace(SECRET, '<redacted>');
}

export function diagnosticReport(input: DiagnosticInput): string {
  const lines: string[] = [];
  const add = (line = '') => lines.push(line);
  add("Tim's AI Hub diagnostic report");
  add(`Generated: ${input.generatedAt.toISOString()}`);
  add(`Hub: ${input.hubVersion}`);
  add(`Platform: ${input.platform}`);
  add();
  add('Proxy');
  add(`  State: ${input.proxy.ready ? 'ready' : input.proxy.running ? 'starting' : 'stopped'}${input.proxy.managed ? ' (started by the hub)' : ''}`);
  add(`  Version: ${input.proxy.version ?? 'unknown'}`);
  add(`  Listens on: ${input.host}${input.allowLan ? ' (network access on)' : ''}`);
  add(`  Proxy keys: ${input.keyCount}`);
  add(`  Compression: ${input.compression ? `${input.compression.enabled ? 'on' : 'off'}, service ${input.compression.running ? 'running' : 'stopped'}` : 'unknown'}`);
  add();
  add('Health check');
  for (const check of input.checks) add(`  [${check.level}] ${check.text}`);
  if (!input.checks.length) add('  (not run)');
  add();
  add(`Accounts (${input.accounts.length})`);
  const byProvider = new Map<string, Map<string, number>>();
  for (const account of input.accounts) {
    const states = byProvider.get(account.provider) ?? new Map<string, number>();
    const state = account.disabled ? 'off' : account.state;
    states.set(state, (states.get(state) ?? 0) + 1);
    byProvider.set(account.provider, states);
  }
  for (const [provider, states] of [...byProvider].sort((a, b) => a[0].localeCompare(b[0]))) {
    add(`  ${provider}: ${[...states].map(([state, count]) => `${count} ${state}`).join(', ')}`);
  }
  add();
  add('Connected apps');
  for (const app of input.apps) {
    const connection = app.connectionMatches === undefined ? '' : app.connectionMatches ? ', connection matches' : ', connection does NOT match';
    add(`  ${app.name}: ${app.installed ? app.state : 'not installed'}${app.installed ? connection : ''}`);
  }
  if (!input.apps.length) add('  (none found)');
  return redact(lines.join('\n')) + '\n';
}
