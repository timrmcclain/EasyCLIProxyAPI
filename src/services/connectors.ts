import { invoke } from '@tauri-apps/api/core';

export type ConnectorId = 'google' | 'microsoft365' | 'github' | 'playwright' | 'windows' | 'firecrawl';
export type ConnectorTarget = 'claudeCode' | 'claudeDesktop';

export type ConnectorTargetState = {
  enabled: boolean;
  access: string | null;
  builtIn: boolean;
  signedIn: boolean | null;
};

export type ConnectorOverviewItem = {
  id: ConnectorId;
  accessLevels: string[];
  secretNames: string[];
  secretsConfigured: boolean;
  unavailableReason: string | null;
  claudeCode: ConnectorTargetState;
  claudeDesktop: ConnectorTargetState;
};

export type ConnectorOverview = {
  connectors: ConnectorOverviewItem[];
  desktopProfile: string | null;
  canUndo: boolean;
  lastChange: string | null;
};

export type ConnectorTestResult = {
  status: 'ok' | 'needsSignIn' | 'builtIn' | 'failed';
  toolCount: number | null;
  message: string | null;
};

export type ConnectorDraft = {
  claudeCode: boolean;
  claudeDesktop: boolean;
  access: string | null;
  secrets: Record<string, string>;
};

export const connectorTargets: readonly ConnectorTarget[] = ['claudeCode', 'claudeDesktop'];

export function draftFromItem(item: ConnectorOverviewItem): ConnectorDraft {
  return {
    claudeCode: item.claudeCode.enabled,
    claudeDesktop: item.claudeDesktop.enabled,
    access: item.claudeCode.access ?? item.claudeDesktop.access ?? item.accessLevels[0] ?? null,
    secrets: {},
  };
}

export function draftChanged(item: ConnectorOverviewItem, draft: ConnectorDraft) {
  const saved = draftFromItem(item);
  return saved.claudeCode !== draft.claudeCode
    || saved.claudeDesktop !== draft.claudeDesktop
    || (item.accessLevels.length > 0 && (draft.claudeCode || draft.claudeDesktop) && saved.access !== draft.access)
    || Object.values(draft.secrets).some(value => value.trim() !== '');
}

/** Secrets the user still has to enter before this draft can be saved. */
export function missingSecrets(item: ConnectorOverviewItem, draft: ConnectorDraft) {
  if (item.secretsConfigured || !(draft.claudeCode || draft.claudeDesktop)) return [];
  return item.secretNames.filter(name => !draft.secrets[name]?.trim());
}

/** Backend errors of the form "missing_secret:NAME" name the absent value. */
export function missingSecretFromError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  const match = /missing_secret:([A-Z0-9_]+)/.exec(text);
  return match ? match[1] : null;
}

export const connectorsApi = {
  overview: () => invoke<ConnectorOverview>('get_connector_overview'),
  apply: (id: ConnectorId, draft: ConnectorDraft) => invoke<ConnectorOverview>('apply_connector_change', {
    request: {
      id,
      claudeCode: draft.claudeCode,
      claudeDesktop: draft.claudeDesktop,
      access: draft.access,
      secrets: Object.fromEntries(Object.entries(draft.secrets).filter(([, value]) => value.trim() !== '')),
    },
  }),
  undo: () => invoke<ConnectorOverview>('undo_connector_change'),
  test: (id: ConnectorId, target: ConnectorTarget) => invoke<ConnectorTestResult>('test_connector', { id, target }),
  aiTest: (id: ConnectorId, today: string) => invoke<ConnectorTestResult>('ai_test_connector', { id, today }),
};

/** Connectors whose Claude Code entry can be checked with a real, read-only AI request. */
export const aiTestableConnectors: readonly ConnectorId[] = ['google', 'microsoft365', 'github'];

/** The local calendar date as YYYY-MM-DD, which the AI test asks about. */
export function localDate(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
