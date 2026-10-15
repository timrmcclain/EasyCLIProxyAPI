import { invoke } from '@tauri-apps/api/core';
import { pluginsApi, type PluginConfigObject } from './plugins';

/** Secret Guard is a proxy plugin bundled with the hub (see `secret-guard/`); this is its id in the proxy. */
export const SECRET_GUARD_ID = 'secret-guard';

export type SecretGuardMode = 'off' | 'report' | 'redact' | 'block';
export const SECRET_GUARD_MODES: SecretGuardMode[] = ['off', 'report', 'redact', 'block'];
/** The plugin maps each request's model to one of these (`provider_for` in secret-guard/src/lib.rs). */
export const SECRET_GUARD_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'meta', 'other'] as const;
export type SecretGuardProvider = typeof SECRET_GUARD_PROVIDERS[number];

export type SecretGuardInfo = {
  bundled: boolean; bundledVersion: string; installed: boolean; findingsFile: string;
  /** Codex response steering is on in the proxy config, so follow-up WebSocket messages skip the check. */
  codexSteeringBypass: boolean;
};
export type SecretGuardInstall = { findingsFile: string; replacedLoadedCopy: boolean };
export type SecretGuardFinding = {
  fingerprint: string; kind: string; firstSeen: number; lastSeen: number; sightings: number;
  providers: string[]; models: string[]; clients: string[]; actions: string[]; dismissedAt: number | null;
};
export type SecretGuardPolicy = { defaultMode: SecretGuardMode; modes: Partial<Record<SecretGuardProvider, SecretGuardMode>>; allow: string[] };
export type SecretGuardStatus = {
  info: SecretGuardInfo;
  /** The user switched it on (the plugin's config says enabled). */
  on: boolean;
  /** The proxy has it loaded and running. */
  running: boolean;
  /** The proxy's own plugin system is switched off, so nothing loads. */
  pluginsOff: boolean;
  loadedVersion: string;
  policy: SecretGuardPolicy;
};

const isMode = (value: unknown): value is SecretGuardMode => SECRET_GUARD_MODES.includes(value as SecretGuardMode);

export function readPolicy(config: PluginConfigObject): SecretGuardPolicy {
  const modes: SecretGuardPolicy['modes'] = {};
  const raw = config.modes && typeof config.modes === 'object' ? config.modes as Record<string, unknown> : {};
  for (const provider of SECRET_GUARD_PROVIDERS) if (isMode(raw[provider])) modes[provider] = raw[provider] as SecretGuardMode;
  return {
    defaultMode: isMode(config.default_mode) ? config.default_mode : 'report',
    modes,
    allow: Array.isArray(config.allow) ? config.allow.filter((item): item is string => typeof item === 'string') : [],
  };
}

/** Each provider's effective mode: its own, or the default. */
export const modeFor = (policy: SecretGuardPolicy, provider: SecretGuardProvider): SecretGuardMode => policy.modes[provider] ?? policy.defaultMode;

const randomSalt = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

/** Which app sent the request, from the user agent the plugin recorded (same rules as Activity). */
export function secretGuardApp(agent: string): string {
  const value = agent.toLowerCase();
  if (value.includes('claude-desktop')) return 'Claude Desktop';
  if (value.includes('claude-cli')) return 'Claude Code';
  if (value.includes('codex')) return 'Codex';
  if (value.includes('opencode')) return 'OpenCode';
  return agent.split(/[\s/]/)[0] || agent;
}

/** Findings the user still needs to act on: not rotated since last seen, not marked safe. */
export const openFindings = (findings: SecretGuardFinding[], policy: SecretGuardPolicy) =>
  findings.filter(item => item.dismissedAt === null && !policy.allow.includes(item.fingerprint));

/**
 * Findings to raise a notification for: seen for the first time since the last check. The first check only
 * records what's already there, so switching the hub on doesn't replay old findings.
 */
export function freshFindings(seen: Set<string> | null, findings: SecretGuardFinding[], policy: SecretGuardPolicy) {
  const open = openFindings(findings, policy);
  const fresh = seen ? open.filter(item => !seen.has(item.fingerprint)) : [];
  const next = new Set([...(seen ?? []), ...findings.map(item => item.fingerprint)]);
  return { fresh, seen: next };
}

async function optionalConfig(): Promise<PluginConfigObject> {
  try {
    return await pluginsApi.getConfig(SECRET_GUARD_ID);
  } catch {
    return {};
  }
}

async function patch(changes: PluginConfigObject) {
  await pluginsApi.patchConfig(SECRET_GUARD_ID, changes);
}

export const secretGuardService = {
  info: () => invoke<SecretGuardInfo>('secret_guard_info'),
  findings: () => invoke<SecretGuardFinding[]>('secret_guard_findings'),
  dismiss: (fingerprint: string, dismissed: boolean) => invoke<void>('secret_guard_dismiss', { fingerprint, dismissed }),

  async status(): Promise<SecretGuardStatus> {
    const [info, list, config] = await Promise.all([this.info(), pluginsApi.list(), optionalConfig()]);
    const entry = list.plugins.find(plugin => plugin.id === SECRET_GUARD_ID);
    return {
      info,
      on: config.enabled === true,
      running: Boolean(entry?.registered && entry.effectiveEnabled),
      pluginsOff: !list.pluginsEnabled,
      loadedVersion: entry?.metadata?.version ?? '',
      policy: readPolicy(config),
    };
  },

  /** Installs the plugin into the proxy and switches it on. The proxy loads it as soon as its config changes. */
  async enable(): Promise<SecretGuardInstall> {
    const install = await invoke<SecretGuardInstall>('secret_guard_install');
    const settings = await pluginsApi.getSettings();
    if (!settings.enabled) await pluginsApi.updateSettings({ enabled: true });
    const current = await optionalConfig();
    await pluginsApi.putConfig(SECRET_GUARD_ID, {
      ...current,
      enabled: true,
      priority: typeof current.priority === 'number' ? current.priority : 100,
      default_mode: isMode(current.default_mode) ? current.default_mode : 'report',
      findings_file: install.findingsFile,
      // Fingerprints are salted per install so a weak password can't be guessed from its fingerprint.
      salt: typeof current.salt === 'string' && current.salt ? current.salt : randomSalt(),
    });
    return install;
  },

  disable: () => pluginsApi.updateEnabled(SECRET_GUARD_ID, false),

  async setMode(provider: SecretGuardProvider | 'default', mode: SecretGuardMode) {
    if (provider === 'default') return patch({ default_mode: mode });
    const policy = readPolicy(await optionalConfig());
    return patch({ modes: { ...policy.modes, [provider]: mode } });
  },

  async setAllowed(fingerprint: string, allowed: boolean) {
    const policy = readPolicy(await optionalConfig());
    const allow = allowed ? [...new Set([...policy.allow, fingerprint])] : policy.allow.filter(item => item !== fingerprint);
    return patch({ allow });
  },
};
