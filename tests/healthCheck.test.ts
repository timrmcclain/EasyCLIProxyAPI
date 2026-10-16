import { describe, expect, it } from 'bun:test';
import { findDuplicateAccounts, findOutrankingKeys, healthChecks, providersWithoutUsableAccount, type HealthInput } from '../src/services/healthCheck';

const healthy: HealthInput = {
  proxyRunning: true, host: '127.0.0.1', exposed: false, portBlockedBy: null, keyCount: 1, managementSecretConfigured: true,
  signInNeeded: [], disabledAccounts: 0, duplicateAccounts: [], totalAccounts: 7, driftedApps: [],
  compression: { enabled: false, running: false }, notificationsAllowed: true, notificationsEnabled: true,
};
const levels = (input: Partial<HealthInput>) => Object.fromEntries(healthChecks({ ...healthy, ...input }).map(check => [check.id, check.level]));

describe('health check', () => {
  it('reports every area as ok on a healthy setup', () => {
    const checks = healthChecks(healthy);
    expect(checks.every(check => check.level === 'ok')).toBe(true);
    expect(checks.map(check => check.id).sort()).toEqual(['accounts', 'apps', 'keys', 'network', 'notifications', 'proxy']);
  });

  it('puts failures first and links each problem to where it is fixed', () => {
    const checks = healthChecks({ ...healthy, proxyRunning: false, keyCount: 3 });
    expect(checks.slice(0, 2).map(check => [check.id, check.level, check.target])).toEqual([['proxy', 'fail', 'home'], ['keys', 'warn', 'config']]);
  });

  it('flags a proxy reachable from the network, and fails it without a management secret', () => {
    expect(levels({ exposed: true })).toMatchObject({ network: 'warn' });
    expect(levels({ exposed: false })).toMatchObject({ network: 'ok' });
    expect(levels({ exposed: true, managementSecretConfigured: false })).toMatchObject({ management: 'fail' });
    expect(levels({ managementSecretConfigured: false }).management).toBeUndefined();
  });

  it('names the program holding the port when the proxy cannot start', () => {
    const blocked = healthChecks({ ...healthy, proxyRunning: false, portBlockedBy: { port: 8317, name: 'node.exe', pid: 4242 } });
    expect(blocked.find(check => check.id === 'proxy')).toMatchObject({ level: 'fail', key: 'health.proxy.portBlocked', variables: { port: 8317, name: 'node.exe', pid: 4242 } });
    expect(healthChecks({ ...healthy, proxyRunning: false }).find(check => check.id === 'proxy')?.key).toBe('health.proxy.stopped');
  });

  it('finds an account signed in twice, ignoring case and accounts without an email', () => {
    expect(findDuplicateAccounts([
      { provider: 'claude', email: 'Me@Example.com' }, { provider: 'claude', email: 'me@example.com ' },
      { provider: 'codex', email: 'me@example.com' }, { provider: 'claude', email: '' }, { provider: 'claude', email: '' },
    ])).toEqual(['claude: Me@Example.com (2)']);
    const check = healthChecks({ ...healthy, duplicateAccounts: ['claude: me@example.com (2)'] }).find(item => item.id === 'duplicates');
    expect(check).toMatchObject({ level: 'warn', key: 'health.accounts.duplicateOne', target: 'oauth' });
  });

  it('names expired sign-ins and drifted apps', () => {
    const checks = healthChecks({ ...healthy, signInNeeded: ['Claude - Gmail'], driftedApps: ['Claude Code'] });
    expect(checks.find(check => check.id === 'accounts')).toMatchObject({ level: 'fail', variables: { accounts: 'Claude - Gmail' }, target: 'oauth' });
    expect(checks.find(check => check.id === 'apps')).toMatchObject({ level: 'fail', variables: { apps: 'Claude Code' }, target: 'agents' });
  });

  it('reports accounts that can\'t take requests even when every sign-in is fine', () => {
    const checks = healthChecks({ ...healthy, unavailable: ['claude-team'] });
    expect(checks.find(check => check.id === 'unavailable')).toMatchObject({ level: 'fail', key: 'health.accounts.unavailableOne', variables: { accounts: 'claude-team' }, target: 'oauth' });
    expect(healthChecks(healthy).some(check => check.id === 'unavailable')).toBe(false);
  });

  it('warns when nothing restarts the proxy after Windows restarts, but only with apps connected', () => {
    const find = (input: Partial<typeof healthy>) => healthChecks({ ...healthy, ...input }).find(check => check.id === 'startup');
    expect(find({ startsWithWindows: { autostart: false, startProxy: true }, connectedApps: 2 })).toMatchObject({ level: 'warn', key: 'health.startup.off' });
    expect(find({ startsWithWindows: { autostart: true, startProxy: false }, connectedApps: 1 })).toMatchObject({ key: 'health.startup.proxyOff' });
    expect(find({ startsWithWindows: { autostart: true, startProxy: true }, connectedApps: 2 })).toBeUndefined();
    expect(find({ startsWithWindows: { autostart: false, startProxy: false }, connectedApps: 0 })).toBeUndefined();
  });

  it('covers no accounts, no keys, disabled accounts, a stray compression service and notifications', () => {
    expect(levels({ totalAccounts: 0 }).accounts).toBe('fail');
    expect(levels({ keyCount: 0 }).keys).toBe('fail');
    expect(levels({ keyCount: 2 }).keys).toBe('ok'); // mid-rotation
    expect(levels({ keyCount: 3 }).keys).toBe('warn');
    expect(levels({ disabledAccounts: 1 }).disabled).toBe('warn');
    expect(levels({ compression: { enabled: false, running: true } }).compression).toBe('warn');
    expect(levels({ compression: { enabled: true, running: true } }).compression).toBeUndefined();
    expect(levels({ notificationsEnabled: false }).notifications).toBe('warn');
    expect(levels({ notificationsAllowed: false }).notifications).toBe('warn');
  });
});

describe('probes that failed', () => {
  it('say "couldn\'t check" instead of reporting a guessed result', () => {
    const checks = healthChecks({ ...healthy, exposed: null, keyCount: null, managementSecretConfigured: null, accountsUnknown: true, driftedApps: null });
    const byId = Object.fromEntries(checks.map(check => [check.id, check]));
    expect(byId.network.key).toBe('health.unknown.network');
    expect(byId.keys.key).toBe('health.unknown.config');
    expect(byId.accounts.key).toBe('health.unknown.accounts');
    expect(byId.apps.key).toBe('health.unknown.apps');
    for (const id of ['network', 'keys', 'accounts', 'apps']) expect(byId[id].level).toBe('warn');
    expect(byId.management).toBeUndefined();
  });
});

describe('findOutrankingKeys', () => {
  const accounts = [
    { provider: 'codex', priority: 2, disabled: false },
    { provider: 'codex', priority: 5, disabled: true },
    { provider: 'claude', priority: 0, disabled: false },
  ];
  it('flags a paid key above every enabled account of its provider', () => {
    expect(findOutrankingKeys([{ section: 'codex-api-key', name: 'Codex Direct', priority: 10, disabled: false }], accounts)).toEqual(['Codex Direct (10 > 2)']);
  });
  it('ignores disabled accounts when finding the best one, and disabled or lower keys', () => {
    expect(findOutrankingKeys([
      { section: 'codex-api-key', name: 'Low', priority: 2, disabled: false },
      { section: 'codex-api-key', name: 'Off', priority: 99, disabled: true },
    ], accounts)).toEqual([]);
  });
  it('says nothing when the provider has no signed-in accounts to compete with', () => {
    expect(findOutrankingKeys([{ section: 'xai-api-key', name: 'Grok key', priority: 10, disabled: false }], accounts)).toEqual([]);
  });
  it('warns on the Health check page with a link to API Access', () => {
    const check = healthChecks({ ...healthy, outrankingKeys: ['Codex Direct (10 > 2)'] }).find(c => c.id === 'paid-keys');
    expect(check).toMatchObject({ level: 'warn', target: 'api' });
  });
});

describe('providersWithoutUsableAccount', () => {
  it('lists a provider only when none of its accounts can take requests', () => {
    expect(providersWithoutUsableAccount([
      { provider: 'claude', usable: false },
      { provider: 'Claude', usable: false },
      { provider: 'codex', usable: false },
      { provider: 'codex', usable: true },
      { provider: '', usable: false },
    ])).toEqual(['claude']);
  });
  it('fails Health check with a link to Accounts, and flags an engine update', () => {
    const checks = healthChecks({ ...healthy, providersWithoutAccount: ['claude'], engineUpdate: { current: '8.0.29', latest: '8.0.31' } });
    expect(checks.find(c => c.id === 'no-usable-account')).toMatchObject({ level: 'fail', target: 'oauth' });
    expect(checks.find(c => c.id === 'engine-update')).toMatchObject({ level: 'warn', target: 'versions', variables: { latest: '8.0.31' } });
  });
});
