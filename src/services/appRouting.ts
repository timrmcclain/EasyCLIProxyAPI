import { invoke } from '@tauri-apps/api/core';
import { authFileHealth } from './authFileHealth';
import { dedupeAuthFiles } from './authFiles';
import { managementApi, responseList } from './managementApi';
import { pluginsApi, type PluginConfigObject } from './plugins';
import { fileName, providerForFile, type AuthFile } from './quotaService';

/**
 * Who pays for each app: the App Routing proxy plugin (see `app-routing/`) gives an app's requests to the accounts
 * chosen for it, highest in the routing order first, and keeps each conversation on the account it started on. Apps
 * without a rule are left to the proxy's normal order. "Prefer" falls back to that order when none of the app's
 * accounts can take a request; "Only" refuses instead.
 */
export const APP_ROUTING_ID = 'app-routing';

export type AppRule = {
  /** Account file names, as the proxy names its credentials. */
  accounts: string[];
  /** Providers those accounts belong to; requests to other providers keep the normal order. */
  providers: string[];
  only: boolean;
};
export type AppRoutingInfo = { bundled: boolean; bundledVersion: string; installed: boolean; installedCurrent: boolean };
export type AppRoutingStatus = {
  info: AppRoutingInfo;
  /** Switched on in the proxy's config. */
  on: boolean;
  /** Loaded and running in the proxy right now. */
  running: boolean;
  loadedVersion: string;
  rules: Record<string, AppRule>;
};
export type RoutingAccount = { name: string; label: string; provider: string };

/** Apps the plugin can tell apart by their User-Agent, matching `client_app` in secret-guard/src/apps.rs. */
export const ROUTABLE_APPS = new Set([
  'claude-desktop', 'claude-code', 'opencode', 'openclaw', 'codex', 'hermes', 'kimi-code', 'grok-build', 'antigravity-cli',
  'zcode', 'workbuddy', 'deepseek-harness',
]);
const APP_NEEDLES: [string, string][] = [
  ['claude-desktop', 'claude-desktop'], ['claude-cli', 'claude-code'], ['claude-code', 'claude-code'], ['opencode', 'opencode'],
  ['openclaw', 'openclaw'], ['codex', 'codex'], ['hermes', 'hermes'], ['kimi', 'kimi-code'], ['grok', 'grok-build'],
  ['antigravity', 'antigravity-cli'], ['zcode', 'zcode'], ['workbuddy', 'workbuddy'], ['deepseek', 'deepseek-harness'],
];
/** The app id the plugin gives a request with this User-Agent; Claude Desktop is checked before Claude Code. */
export function appIdFromUserAgent(userAgent: string): string {
  const agent = userAgent.toLowerCase();
  return APP_NEEDLES.find(([needle]) => agent.includes(needle))?.[1] ?? 'other';
}

const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];

/** The rules in the plugin's config, ignoring anything malformed and any rule with no accounts. */
export function readRules(config: PluginConfigObject): Record<string, AppRule> {
  const raw = config.rules;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const rules: Record<string, AppRule> = {};
  for (const [app, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const rule = value as Record<string, unknown>;
    const accounts = strings(rule.accounts);
    if (!accounts.length) continue;
    rules[app] = { accounts, providers: strings(rule.providers), only: rule.only === true };
  }
  return rules;
}

const providerOf = (file: AuthFile) => providerForFile(file)
  ?? String(file.provider ?? file.type ?? '').trim().toLowerCase();

/** Accounts an app can be given, by provider, in a stable order; switched-off accounts are left out. */
export function routingAccounts(files: AuthFile[]): RoutingAccount[] {
  return files
    .filter(file => !authFileHealth(file).disabled && providerOf(file))
    .map(file => ({ name: fileName(file), label: String(file.email ?? file.label ?? '').trim() || fileName(file), provider: providerOf(file) }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

/** The rule for the chosen accounts; the providers come from the accounts, so other providers keep the normal order. */
export function ruleFor(accounts: RoutingAccount[], chosen: string[], only: boolean): AppRule | null {
  const picked = accounts.filter(account => chosen.includes(account.name));
  if (!picked.length) return null;
  return { accounts: picked.map(account => account.name), providers: [...new Set(picked.map(account => account.provider))].sort(), only };
}

/** True when the rule sends this app to this account (by file name). */
export const ruleUses = (rule: AppRule | undefined, account: string) =>
  Boolean(rule?.accounts.some(name => name.toLowerCase() === account.toLowerCase()));

const currentConfig = () => pluginsApi.getConfig(APP_ROUTING_ID);

export const appRoutingService = {
  info: () => invoke<AppRoutingInfo>('app_routing_info'),
  accounts: async () => routingAccounts(dedupeAuthFiles(responseList(await managementApi.get('/credentials'), 'files'))),

  async status(): Promise<AppRoutingStatus> {
    const [info, list, config] = await Promise.all([this.info(), pluginsApi.list(), currentConfig()]);
    const entry = list.plugins.find(plugin => plugin.id === APP_ROUTING_ID);
    return {
      info,
      on: config.enabled === true,
      running: Boolean(entry?.registered && entry.effectiveEnabled),
      loadedVersion: entry?.metadata?.version ?? '',
      rules: readRules(config),
    };
  },

  /**
   * Sets or (with null) removes one app's rule. The first rule installs the plugin and switches it on; the proxy
   * loads it as soon as its config changes. Other apps' rules are kept as they are.
   */
  async setRule(app: string, rule: AppRule | null) {
    const current = await currentConfig();
    const { [app]: _previous, ...others } = readRules(current);
    const rules = rule ? { ...others, [app]: rule } : others;
    if (rule && current.enabled !== true) {
      await invoke('app_routing_install');
      const settings = await pluginsApi.getSettings();
      if (!settings.enabled) await pluginsApi.updateSettings({ enabled: true });
    }
    // PUT the whole entry so a removed rule is really gone (the proxy's PATCH merges objects).
    await pluginsApi.putConfig(APP_ROUTING_ID, {
      ...current,
      enabled: rule ? true : current.enabled === true,
      priority: typeof current.priority === 'number' ? current.priority : 100,
      rules,
    });
  },
};
