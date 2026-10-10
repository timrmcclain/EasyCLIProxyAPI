import { describe, expect, it } from 'bun:test';
import { healthChecks, type HealthInput } from '../src/services/healthCheck';

const healthy: HealthInput = {
  proxyRunning: true, host: '127.0.0.1', allowLan: false, keyCount: 1, managementSecretConfigured: true,
  signInNeeded: [], disabledAccounts: 0, totalAccounts: 7, driftedApps: [],
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
    expect(levels({ allowLan: true })).toMatchObject({ network: 'warn' });
    expect(levels({ host: '0.0.0.0' })).toMatchObject({ network: 'warn' });
    expect(levels({ host: 'localhost' })).toMatchObject({ network: 'ok' });
    expect(levels({ host: '0.0.0.0', managementSecretConfigured: false })).toMatchObject({ management: 'fail' });
    expect(levels({ managementSecretConfigured: false }).management).toBeUndefined();
  });

  it('names expired sign-ins and drifted apps', () => {
    const checks = healthChecks({ ...healthy, signInNeeded: ['Claude - Gmail'], driftedApps: ['Claude Code'] });
    expect(checks.find(check => check.id === 'accounts')).toMatchObject({ level: 'fail', variables: { accounts: 'Claude - Gmail' }, target: 'oauth' });
    expect(checks.find(check => check.id === 'apps')).toMatchObject({ level: 'fail', variables: { apps: 'Claude Code' }, target: 'agents' });
  });

  it('covers no accounts, no keys, disabled accounts, a stray compression service and notifications', () => {
    expect(levels({ totalAccounts: 0 }).accounts).toBe('fail');
    expect(levels({ keyCount: 0 }).keys).toBe('fail');
    expect(levels({ keyCount: 2 }).keys).toBe('warn');
    expect(levels({ disabledAccounts: 1 }).disabled).toBe('warn');
    expect(levels({ compression: { enabled: false, running: true } }).compression).toBe('warn');
    expect(levels({ compression: { enabled: true, running: true } }).compression).toBeUndefined();
    expect(levels({ notificationsEnabled: false }).notifications).toBe('warn');
    expect(levels({ notificationsAllowed: false }).notifications).toBe('warn');
  });
});
