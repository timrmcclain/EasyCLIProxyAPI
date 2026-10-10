/**
 * One list of everything worth fixing, each with where to fix it. Inputs are plain values so the
 * rules can be tested without the app; the Health check page gathers them.
 */
export type HealthLevel = 'ok' | 'warn' | 'fail';
export type HealthTarget = 'home' | 'oauth' | 'agents' | 'config' | 'compression' | 'proxy';
export type HealthCheck = {
  id: string;
  level: HealthLevel;
  /** Message key under health.*; variables fill it in. */
  key: string;
  variables?: Record<string, string | number>;
  target?: HealthTarget;
};

export type HealthInput = {
  proxyRunning: boolean;
  /** Address the proxy listens on; anything but loopback is reachable from the network. */
  host: string;
  allowLan: boolean;
  keyCount: number;
  managementSecretConfigured: boolean;
  /** Labels of accounts whose sign-in expired or was revoked. */
  signInNeeded: string[];
  disabledAccounts: number;
  totalAccounts: number;
  /** Names of connected apps whose settings stopped matching the hub. */
  driftedApps: string[];
  compression: { enabled: boolean; running: boolean } | null;
  /** Null when the hub can't tell (e.g. permission never asked). */
  notificationsAllowed: boolean | null;
  notificationsEnabled: boolean;
};

const loopback = (host: string) => ['', '127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.trim().toLowerCase());
const rank: Record<HealthLevel, number> = { fail: 0, warn: 1, ok: 2 };

export function healthChecks(input: HealthInput): HealthCheck[] {
  const checks: HealthCheck[] = [];
  checks.push(input.proxyRunning
    ? { id: 'proxy', level: 'ok', key: 'health.proxy.ok' }
    : { id: 'proxy', level: 'fail', key: 'health.proxy.stopped', target: 'home' });

  const exposed = input.allowLan || !loopback(input.host);
  checks.push(exposed
    ? { id: 'network', level: 'warn', key: 'health.network.exposed', variables: { host: input.host || '0.0.0.0' }, target: 'config' }
    : { id: 'network', level: 'ok', key: 'health.network.local' });

  if (!input.totalAccounts) checks.push({ id: 'accounts', level: 'fail', key: 'health.accounts.none', target: 'oauth' });
  else if (input.signInNeeded.length) checks.push({ id: 'accounts', level: 'fail', key: input.signInNeeded.length === 1 ? 'health.accounts.signInOne' : 'health.accounts.signIn', variables: { count: input.signInNeeded.length, accounts: input.signInNeeded.join(', ') }, target: 'oauth' });
  else checks.push({ id: 'accounts', level: 'ok', key: input.totalAccounts === 1 ? 'health.accounts.okOne' : 'health.accounts.ok', variables: { count: input.totalAccounts } });
  if (input.disabledAccounts) checks.push({ id: 'disabled', level: 'warn', key: input.disabledAccounts === 1 ? 'health.accounts.disabledOne' : 'health.accounts.disabled', variables: { count: input.disabledAccounts }, target: 'oauth' });

  checks.push(input.driftedApps.length
    ? { id: 'apps', level: 'fail', key: input.driftedApps.length === 1 ? 'health.apps.driftedOne' : 'health.apps.drifted', variables: { apps: input.driftedApps.join(', ') }, target: 'agents' }
    : { id: 'apps', level: 'ok', key: 'health.apps.ok' });

  // A second key is normal mid-rotation; more than that is usually a forgotten old key.
  if (input.keyCount === 0) checks.push({ id: 'keys', level: 'fail', key: 'health.keys.none', target: 'config' });
  else if (input.keyCount > 1) checks.push({ id: 'keys', level: 'warn', key: 'health.keys.extra', variables: { count: input.keyCount }, target: 'config' });
  else checks.push({ id: 'keys', level: 'ok', key: 'health.keys.ok' });

  if (exposed && !input.managementSecretConfigured) checks.push({ id: 'management', level: 'fail', key: 'health.management.open', target: 'config' });

  if (input.compression?.running && !input.compression.enabled) checks.push({ id: 'compression', level: 'warn', key: 'health.compression.stray', target: 'compression' });

  if (!input.notificationsEnabled) checks.push({ id: 'notifications', level: 'warn', key: 'health.notifications.off', target: 'config' });
  else if (input.notificationsAllowed === false) checks.push({ id: 'notifications', level: 'warn', key: 'health.notifications.blocked' });
  else checks.push({ id: 'notifications', level: 'ok', key: 'health.notifications.ok' });

  return checks.sort((a, b) => rank[a.level] - rank[b.level]);
}
