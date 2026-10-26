import type { SettingsCategory } from './settingsNavigation';

/** One sentence of a Settings tab's plain-language summary: a message key and its values. */
export type SummaryLine = { key: string; vars?: Record<string, string | number> };

export type SummaryInput = {
  core?: {
    host: string; port: number; allowLan: boolean; apiKeys: number; managementSecretConfigured: boolean;
    routingStrategy: string; routingSessionAffinity: boolean; disableCooling: boolean;
    requestRetry: number; maxRetryCredentials: number;
    loggingToFile: boolean; logsMaxTotalSizeMb: number; debug: boolean; usageStatisticsEnabled: boolean;
  } | null;
  tls?: boolean | null;
  software?: { autostartEnabled: boolean; startCoreOnLaunch: boolean; silentStartEnabled: boolean; closeBehavior: string } | null;
};

/**
 * What a Settings tab is for and what it is set to now, as sentences built from the saved values (not the
 * unsaved drafts), so the summary never claims something that hasn't been saved.
 */
export function settingsSummary(category: SettingsCategory, input: SummaryInput): SummaryLine[] {
  const lines: SummaryLine[] = [{ key: `sp.purpose.${category}` }];
  const core = input.core;
  if (category === 'general' && core) {
    const scheme = input.tls ? 'https' : 'http';
    lines.push({ key: 'sp.general.address', vars: { address: `${scheme}://${core.host || '127.0.0.1'}:${core.port}`, count: core.apiKeys } });
    lines.push({ key: core.allowLan || (core.host !== '' && core.host !== '127.0.0.1' && core.host !== 'localhost') ? 'sp.general.lan' : 'sp.general.local' });
    lines.push({ key: core.managementSecretConfigured ? 'sp.general.panelLocked' : 'sp.general.panelOpen' });
  }
  if (category === 'routing' && core) {
    lines.push({ key: core.routingStrategy === 'fill-first' ? 'sp.routing.fillFirst' : 'sp.routing.roundRobin' });
    lines.push({ key: core.routingSessionAffinity ? 'sp.routing.sticky' : 'sp.routing.notSticky' });
    lines.push(core.requestRetry > 0
      ? { key: core.maxRetryCredentials > 0 ? 'sp.routing.retryLimited' : 'sp.routing.retryAll', vars: { count: core.requestRetry, accounts: core.maxRetryCredentials } }
      : { key: 'sp.routing.noRetry' });
    lines.push({ key: core.disableCooling ? 'sp.routing.noCooling' : 'sp.routing.cooling' });
  }
  if (category === 'diagnostics' && core) {
    lines.push(core.loggingToFile
      ? { key: core.logsMaxTotalSizeMb > 0 ? 'sp.diagnostics.fileLimited' : 'sp.diagnostics.fileUnlimited', vars: { size: core.logsMaxTotalSizeMb } }
      : { key: 'sp.diagnostics.noFile' });
    if (core.debug) lines.push({ key: 'sp.diagnostics.debug' });
    lines.push({ key: core.usageStatisticsEnabled ? 'sp.diagnostics.usage' : 'sp.diagnostics.noUsage' });
  }
  if (category === 'software' && input.software) {
    const software = input.software;
    lines.push({ key: software.autostartEnabled ? (software.silentStartEnabled ? 'sp.software.autostartSilent' : 'sp.software.autostart') : 'sp.software.manualStart' });
    lines.push({ key: software.startCoreOnLaunch ? 'sp.software.startsHub' : 'sp.software.hubManual' });
    if (software.closeBehavior !== 'ask') lines.push({ key: software.closeBehavior === 'exit' ? 'sp.software.close.exit' : 'sp.software.close.tray' });
  }
  return lines;
}

/** Tabs whose saves only rewrite settings, never restart the proxy or touch keys, so they can save as you go. */
export const AUTOSAVE_TABS: readonly SettingsCategory[] = ['routing', 'requests', 'oauth', 'extensions', 'software'];
/** Of those, the ones saved into config.yaml, whose previous version the config history can put back. */
export const UNDOABLE_TABS: readonly SettingsCategory[] = ['routing', 'requests', 'oauth', 'extensions'];
