/**
 * One list of everything worth fixing, each with where to fix it. Inputs are plain values so the
 * rules can be tested without the app; the Health check page gathers them.
 */
export type HealthLevel = 'ok' | 'warn' | 'fail';
export type HealthTarget = 'home' | 'oauth' | 'agents' | 'config' | 'compression' | 'proxy' | 'api' | 'versions';
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
  /** From the proxy's config: an empty or wildcard host listens on every interface. Null when it couldn't be read. */
  exposed: boolean | null;
  /** Another program holds the proxy's port, so the proxy can't start. Only checked while the proxy is stopped. */
  portBlockedBy: { port: number; name: string; pid: number } | null;
  /** Null when the proxy config couldn't be read; the checks then say so instead of guessing. */
  keyCount: number | null;
  managementSecretConfigured: boolean | null;
  /** Labels of accounts whose sign-in expired or was revoked. */
  signInNeeded: string[];
  /** Refused for other reasons (rejected, plan blocked); kept apart so the advice fits. */
  unavailable?: string[];
  disabledAccounts: number;
  /** One entry per account signed in more than once, e.g. "claude: someone@example.com (2)". */
  duplicateAccounts: string[];
  totalAccounts: number;
  /** The account list couldn't be read, so account checks are unknown rather than "none". */
  accountsUnknown?: boolean;
  /** Names of connected apps whose settings stopped matching the hub. */
  /** Null when the connected apps couldn't be checked. */
  driftedApps: string[] | null;
  compression: { enabled: boolean; running: boolean } | null;
  /** Null when the hub can't tell (e.g. permission never asked). */
  notificationsAllowed: boolean | null;
  notificationsEnabled: boolean;
  /** Whether the hub, and then the proxy, come back by themselves after Windows restarts. Null when unknown. */
  startsWithWindows?: { autostart: boolean; startProxy: boolean } | null;
  connectedApps?: number;
  /** Paid API keys that outrank every enabled subscription account of the same provider. Null when unknown. */
  outrankingKeys?: string[] | null;
  /** Providers with accounts but none that can take requests, so every app request for them fails. */
  providersWithoutAccount?: string[];
  /** A newer proxy engine is available. */
  engineUpdate?: { current: string; latest: string } | null;
};

const rank: Record<HealthLevel, number> = { fail: 0, warn: 1, ok: 2 };

/** Providers where every account is switched off or refused, so nothing can serve that provider's models. */
export function providersWithoutUsableAccount(accounts: { provider: string; usable: boolean }[]): string[] {
  const usable = new Map<string, boolean>();
  for (const { provider, usable: ok } of accounts) {
    const key = provider.toLowerCase();
    if (!key) continue;
    usable.set(key, (usable.get(key) ?? false) || ok);
  }
  return [...usable].filter(([, ok]) => !ok).map(([provider]) => provider).sort();
}

/** API key sections whose keys share a scheduler with the same provider's signed-in accounts. */
const keyProvider: Record<string, string> = { 'claude-api-key': 'claude', 'codex-api-key': 'codex', 'xai-api-key': 'xai', 'meta-api-key': 'meta' };

/**
 * The proxy only uses the highest-priority group of ready credentials for a model, so a paid key
 * above every subscription account takes all of that provider's traffic and bills per use.
 */
export function findOutrankingKeys(
  keys: { section: string; name: string; priority: number; disabled: boolean }[],
  accounts: { provider: string; priority: number; disabled: boolean }[],
): string[] {
  const best = new Map<string, number>();
  for (const account of accounts) {
    if (account.disabled) continue;
    const provider = account.provider.toLowerCase();
    best.set(provider, Math.max(best.get(provider) ?? -Infinity, account.priority));
  }
  return keys.flatMap(key => {
    const provider = keyProvider[key.section];
    const top = provider ? best.get(provider) : undefined;
    return !key.disabled && top !== undefined && key.priority > top ? [`${key.name} (${key.priority} > ${top})`] : [];
  });
}

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
  checks.push(exposed === null
    ? { id: 'network', level: 'warn', key: 'health.unknown.network' }
    : exposed
      ? { id: 'network', level: 'warn', key: 'health.network.exposed', variables: { host: input.host || '0.0.0.0' }, target: 'config' }
      : { id: 'network', level: 'ok', key: 'health.network.local' });

  if (input.accountsUnknown) checks.push({ id: 'accounts', level: 'warn', key: 'health.unknown.accounts', target: 'oauth' });
  else if (!input.totalAccounts) checks.push({ id: 'accounts', level: 'fail', key: 'health.accounts.none', target: 'oauth' });
  else if (input.signInNeeded.length) checks.push({ id: 'accounts', level: 'fail', key: input.signInNeeded.length === 1 ? 'health.accounts.signInOne' : 'health.accounts.signIn', variables: { count: input.signInNeeded.length, accounts: input.signInNeeded.join(', ') }, target: 'oauth' });
  else checks.push({ id: 'accounts', level: 'ok', key: input.totalAccounts === 1 ? 'health.accounts.okOne' : 'health.accounts.ok', variables: { count: input.totalAccounts } });
  if (!input.accountsUnknown && input.unavailable?.length) checks.push({ id: 'unavailable', level: 'fail', key: input.unavailable.length === 1 ? 'health.accounts.unavailableOne' : 'health.accounts.unavailable', variables: { count: input.unavailable.length, accounts: input.unavailable.join(', ') }, target: 'oauth' });
  if (input.duplicateAccounts.length) checks.push({ id: 'duplicates', level: 'warn', key: input.duplicateAccounts.length === 1 ? 'health.accounts.duplicateOne' : 'health.accounts.duplicate', variables: { count: input.duplicateAccounts.length, accounts: input.duplicateAccounts.join(', ') }, target: 'oauth' });
  if (input.disabledAccounts) checks.push({ id: 'disabled', level: 'warn', key: input.disabledAccounts === 1 ? 'health.accounts.disabledOne' : 'health.accounts.disabled', variables: { count: input.disabledAccounts }, target: 'oauth' });

  checks.push(input.driftedApps === null
    ? { id: 'apps', level: 'warn', key: 'health.unknown.apps', target: 'agents' }
    : input.driftedApps.length
    ? { id: 'apps', level: 'fail', key: input.driftedApps.length === 1 ? 'health.apps.driftedOne' : 'health.apps.drifted', variables: { apps: input.driftedApps.join(', ') }, target: 'agents' }
    : { id: 'apps', level: 'ok', key: 'health.apps.ok' });

  // A second key is normal mid-rotation; more than that is usually a forgotten old key.
  if (input.keyCount === null) checks.push({ id: 'keys', level: 'warn', key: 'health.unknown.config', target: 'config' });
  else if (input.keyCount === 0) checks.push({ id: 'keys', level: 'fail', key: 'health.keys.none', target: 'config' });
  else if (input.keyCount === 2) checks.push({ id: 'keys', level: 'ok', key: 'health.keys.rotating' });
  else if (input.keyCount > 2) checks.push({ id: 'keys', level: 'warn', key: 'health.keys.extra', variables: { count: input.keyCount }, target: 'config' });
  else checks.push({ id: 'keys', level: 'ok', key: 'health.keys.ok' });

  if (exposed && input.managementSecretConfigured === false) checks.push({ id: 'management', level: 'fail', key: 'health.management.open', target: 'config' });

  if (input.compression?.running && !input.compression.enabled) checks.push({ id: 'compression', level: 'warn', key: 'health.compression.stray', target: 'compression' });

  // Connected apps send everything through the proxy; if nothing starts it after a reboot, they all fail until you open the hub.
  if (input.providersWithoutAccount?.length) checks.push({ id: 'no-usable-account', level: 'fail', key: 'health.noUsableAccount', variables: { providers: input.providersWithoutAccount.join(', ') }, target: 'oauth' });
  if (input.engineUpdate) checks.push({ id: 'engine-update', level: 'warn', key: 'health.engineUpdate', variables: input.engineUpdate, target: 'versions' });
  if (input.outrankingKeys?.length) checks.push({ id: 'paid-keys', level: 'warn', key: 'health.paidKeys', variables: { keys: input.outrankingKeys.join(', ') }, target: 'api' });

  const boot = input.startsWithWindows;
  if (boot && (input.connectedApps ?? 0) > 0 && (!boot.autostart || !boot.startProxy)) checks.push({ id: 'startup', level: 'warn', key: boot.autostart ? 'health.startup.proxyOff' : 'health.startup.off', target: 'config' });

  if (!input.notificationsEnabled) checks.push({ id: 'notifications', level: 'warn', key: 'health.notifications.off', target: 'config' });
  else if (input.notificationsAllowed === false) checks.push({ id: 'notifications', level: 'warn', key: 'health.notifications.blocked' });
  else checks.push({ id: 'notifications', level: 'ok', key: 'health.notifications.ok' });

  return checks.sort((a, b) => rank[a.level] - rank[b.level]);
}
