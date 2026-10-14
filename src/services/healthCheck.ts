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
  /** Address the proxy listens on, for the message. */
  host: string;
  /** From the proxy's config: an empty or wildcard host listens on every interface. */
  exposed: boolean;
  /** Another program holds the proxy's port, so the proxy can't start. Only checked while the proxy is stopped. */
  portBlockedBy: { port: number; name: string; pid: number } | null;
  keyCount: number;
  managementSecretConfigured: boolean;
  /** Labels of accounts whose sign-in expired or was revoked. */
  signInNeeded: string[];
  disabledAccounts: number;
  /** One entry per account signed in more than once, e.g. "claude: someone@example.com (2)". */
  duplicateAccounts: string[];
  totalAccounts: number;
  /** Names of connected apps whose settings stopped matching the hub. */
  driftedApps: string[];
  compression: { enabled: boolean; running: boolean } | null;
  /** Null when the hub can't tell (e.g. permission never asked). */
  notificationsAllowed: boolean | null;
  notificationsEnabled: boolean;
};

const rank: Record<HealthLevel, number> = { fail: 0, warn: 1, ok: 2 };

/**
 * Accounts signed in more than once: separate credential files for the same provider and email.
 * Each copy takes a rotation slot but shares one quota, so the proxy keeps retrying an exhausted account.
 */
export function findDuplicateAccounts(accounts: { provider: string; email: string }[]): string[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const { provider, email } of accounts) {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) continue;
    const key = `${provider.toLowerCase()}|${address}`;
    const entry = counts.get(key) ?? { label: `${provider}: ${email.trim()}`, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].filter(entry => entry.count > 1).map(entry => `${entry.label} (${entry.count})`);
}

export function healthChecks(input: HealthInput): HealthCheck[] {
  const checks: HealthCheck[] = [];
  checks.push(input.proxyRunning
    ? { id: 'proxy', level: 'ok', key: 'health.proxy.ok' }
    : input.portBlockedBy
      ? { id: 'proxy', level: 'fail', key: 'health.proxy.portBlocked', variables: { ...input.portBlockedBy }, target: 'home' }
      : { id: 'proxy', level: 'fail', key: 'health.proxy.stopped', target: 'home' });

  const exposed = input.exposed;
  checks.push(exposed
    ? { id: 'network', level: 'warn', key: 'health.network.exposed', variables: { host: input.host || '0.0.0.0' }, target: 'config' }
    : { id: 'network', level: 'ok', key: 'health.network.local' });

  if (!input.totalAccounts) checks.push({ id: 'accounts', level: 'fail', key: 'health.accounts.none', target: 'oauth' });
  else if (input.signInNeeded.length) checks.push({ id: 'accounts', level: 'fail', key: input.signInNeeded.length === 1 ? 'health.accounts.signInOne' : 'health.accounts.signIn', variables: { count: input.signInNeeded.length, accounts: input.signInNeeded.join(', ') }, target: 'oauth' });
  else checks.push({ id: 'accounts', level: 'ok', key: input.totalAccounts === 1 ? 'health.accounts.okOne' : 'health.accounts.ok', variables: { count: input.totalAccounts } });
  if (input.duplicateAccounts.length) checks.push({ id: 'duplicates', level: 'warn', key: input.duplicateAccounts.length === 1 ? 'health.accounts.duplicateOne' : 'health.accounts.duplicate', variables: { count: input.duplicateAccounts.length, accounts: input.duplicateAccounts.join(', ') }, target: 'oauth' });
  if (input.disabledAccounts) checks.push({ id: 'disabled', level: 'warn', key: input.disabledAccounts === 1 ? 'health.accounts.disabledOne' : 'health.accounts.disabled', variables: { count: input.disabledAccounts }, target: 'oauth' });

  checks.push(input.driftedApps.length
    ? { id: 'apps', level: 'fail', key: input.driftedApps.length === 1 ? 'health.apps.driftedOne' : 'health.apps.drifted', variables: { apps: input.driftedApps.join(', ') }, target: 'agents' }
    : { id: 'apps', level: 'ok', key: 'health.apps.ok' });

  // A second key is normal mid-rotation; more than that is usually a forgotten old key.
  if (input.keyCount === 0) checks.push({ id: 'keys', level: 'fail', key: 'health.keys.none', target: 'config' });
  else if (input.keyCount === 2) checks.push({ id: 'keys', level: 'ok', key: 'health.keys.rotating' });
  else if (input.keyCount > 2) checks.push({ id: 'keys', level: 'warn', key: 'health.keys.extra', variables: { count: input.keyCount }, target: 'config' });
  else checks.push({ id: 'keys', level: 'ok', key: 'health.keys.ok' });

  if (exposed && !input.managementSecretConfigured) checks.push({ id: 'management', level: 'fail', key: 'health.management.open', target: 'config' });

  if (input.compression?.running && !input.compression.enabled) checks.push({ id: 'compression', level: 'warn', key: 'health.compression.stray', target: 'compression' });

  if (!input.notificationsEnabled) checks.push({ id: 'notifications', level: 'warn', key: 'health.notifications.off', target: 'config' });
  else if (input.notificationsAllowed === false) checks.push({ id: 'notifications', level: 'warn', key: 'health.notifications.blocked' });
  else checks.push({ id: 'notifications', level: 'ok', key: 'health.notifications.ok' });

  return checks.sort((a, b) => rank[a.level] - rank[b.level]);
}
