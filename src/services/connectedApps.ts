import { invoke } from '@tauri-apps/api/core';

type ModelMappings = { sonnet: string; opus: string; [key: string]: unknown };

/** The parts of a Connected apps status that drift detection and re-applying need. */
export type ConnectedAppStatus = {
  id: string;
  name: string;
  installed: boolean;
  connectionState: 'configured' | 'not-configured' | 'needs-update' | 'invalid';
  /** Right address and key, so requests reach the proxy, even if optional settings are missing. */
  connectionMatches?: boolean;
  currentModel: string | null;
  oauthConfiguration: boolean;
  claudeCodeModelMappings: ModelMappings | null;
  claudeDesktopModelMappings: ModelMappings | null;
};

export type ReapplyOutcome = { id: string; name: string; result: 'reapplied' | 'manual' | 'failed'; error?: string };

export const loadAppStatuses = (refresh = false) =>
  invoke<ConnectedAppStatus[]>(refresh ? 'refresh_agent_config_statuses' : 'get_agent_config_statuses');

/** Apps the hub set up earlier whose old key, address or port means their requests no longer reach it. */
export const driftedApps = (statuses: ConnectedAppStatus[]) =>
  statuses.filter(status => status.installed && status.connectionState === 'needs-update' && status.connectionMatches !== true);

/** What the app was last set up with, so re-applying keeps its models. Null when that can't be read back. */
export function reapplyArguments(status: ConnectedAppStatus) {
  // Codex needs its model catalogue chosen again, so it stays a manual repair on Connected apps.
  if (status.id === 'codex') return null;
  const mappings = status.id === 'claude-code' ? status.claudeCodeModelMappings
    : status.id === 'claude-desktop' ? status.claudeDesktopModelMappings : null;
  const model = mappings ? mappings.sonnet : status.currentModel;
  if (!model) return null;
  return {
    client: status.id,
    model,
    oauthConfiguration: status.oauthConfiguration,
    claudeCodeModelMappings: status.id === 'claude-code' ? mappings : null,
    claudeDesktopModelMappings: status.id === 'claude-desktop' ? mappings : null,
  };
}

/** Re-applies each app with its current models, after a restorable backup, like Repair on Connected apps. */
export async function reapplyApps(statuses: ConnectedAppStatus[]): Promise<ReapplyOutcome[]> {
  const outcomes: ReapplyOutcome[] = [];
  for (const status of statuses) {
    const args = reapplyArguments(status);
    if (!args) { outcomes.push({ id: status.id, name: status.name, result: 'manual' }); continue; }
    try {
      const backup = await invoke<{ id: string; restorable: boolean }>('create_agent_config_backup', { client: status.id });
      if (!backup.id || !backup.restorable) throw new Error('Could not create a restorable backup');
      await invoke('update_agent_config', args);
      outcomes.push({ id: status.id, name: status.name, result: 'reapplied' });
    } catch (error) {
      outcomes.push({ id: status.id, name: status.name, result: 'failed', error: String(error) });
    }
  }
  return outcomes;
}

export function generateProxyKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `sk-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Replaces the key apps use: adds a new key, puts it first (apps are always given the first key),
 * then re-applies every app that was using the old one. The old key keeps working until removed
 * separately, so open sessions aren't cut off mid-task.
 */
export async function rotateProxyKey(remark: string): Promise<{ previousKey: string | null; outcomes: ReapplyOutcome[] }> {
  const before = await loadAppStatuses(true);
  const connected = new Set(before.filter(status => status.installed && status.connectionState === 'configured').map(status => status.id));
  const settings = await invoke<{ apiKeys: { apiKey: string }[] }>('get_core_config_settings');
  const previousKey = settings.apiKeys[0]?.apiKey ?? null;
  const key = generateProxyKey();
  await invoke('add_core_api_key', { apiKey: key, remark });
  await invoke('promote_core_api_key', { apiKey: key });
  const after = await loadAppStatuses(true);
  const outcomes = await reapplyApps(after.filter(status => connected.has(status.id) || status.connectionState === 'needs-update'));
  await loadAppStatuses(true);
  return { previousKey, outcomes };
}
