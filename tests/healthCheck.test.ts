import { describe, expect, it } from 'bun:test';
import { findDuplicateAccounts, healthChecks, type HealthInput } from '../src/services/healthCheck';

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
