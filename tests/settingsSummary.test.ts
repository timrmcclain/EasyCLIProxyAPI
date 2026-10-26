import { describe, expect, it } from 'bun:test';
import { AUTOSAVE_TABS, UNDOABLE_TABS, settingsSummary } from '../src/services/settingsSummary';

const core = {
  host: '127.0.0.1', port: 8317, allowLan: false, apiKeys: 2, managementSecretConfigured: true,
  routingStrategy: 'round-robin', routingSessionAffinity: true, disableCooling: false,
  requestRetry: 3, maxRetryCredentials: 0,
  loggingToFile: true, logsMaxTotalSizeMb: 0, debug: false, usageStatisticsEnabled: true,
};
const keys = (category: Parameters<typeof settingsSummary>[0], input: Parameters<typeof settingsSummary>[1]) =>
  settingsSummary(category, input).map(line => line.key);

describe('settings summary', () => {
  it('starts every tab with what it is for', () => {
    expect(keys('storage', {})).toEqual(['sp.purpose.storage']);
    expect(keys('general', { core: null })).toEqual(['sp.purpose.general']);
  });

  it('says how apps reach the hub, from the saved address, TLS and keys', () => {
    const lines = settingsSummary('general', { core, tls: true });
    expect(lines[1]).toEqual({ key: 'sp.general.address', vars: { address: 'https://127.0.0.1:8317', count: 2 } });
    expect(lines.map(line => line.key).slice(2)).toEqual(['sp.general.local', 'sp.general.panelLocked']);
    expect(keys('general', { core: { ...core, host: '0.0.0.0' } })).toContain('sp.general.lan');
  });

  it('describes routing and retries in sentences', () => {
    expect(keys('routing', { core })).toEqual(['sp.purpose.routing', 'sp.routing.roundRobin', 'sp.routing.sticky', 'sp.routing.retryAll', 'sp.routing.cooling']);
    const strict = settingsSummary('routing', { core: { ...core, routingStrategy: 'fill-first', routingSessionAffinity: false, maxRetryCredentials: 2, disableCooling: true } });
    expect(strict.map(line => line.key)).toEqual(['sp.purpose.routing', 'sp.routing.fillFirst', 'sp.routing.notSticky', 'sp.routing.retryLimited', 'sp.routing.noCooling']);
    expect(strict[3].vars).toEqual({ count: 3, accounts: 2 });
    expect(keys('routing', { core: { ...core, requestRetry: 0 } })).toContain('sp.routing.noRetry');
  });

  it('describes logging and the app itself', () => {
    expect(keys('diagnostics', { core: { ...core, debug: true } })).toEqual(['sp.purpose.diagnostics', 'sp.diagnostics.fileUnlimited', 'sp.diagnostics.debug', 'sp.diagnostics.usage']);
    expect(keys('software', { software: { autostartEnabled: true, silentStartEnabled: true, startCoreOnLaunch: true, closeBehavior: 'minimize-to-tray' } }))
      .toEqual(['sp.purpose.software', 'sp.software.autostartSilent', 'sp.software.startsHub', 'sp.software.close.tray']);
  });

  it('never autosaves tabs that restart the hub or change keys, and only undoes config.yaml tabs', () => {
    expect(AUTOSAVE_TABS).not.toContain('general');
    expect(AUTOSAVE_TABS).not.toContain('diagnostics');
    expect(UNDOABLE_TABS.every(tab => AUTOSAVE_TABS.includes(tab))).toBe(true);
    expect(UNDOABLE_TABS).not.toContain('software');
  });
});
