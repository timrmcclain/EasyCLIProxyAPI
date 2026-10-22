import { invoke } from '@tauri-apps/api/core';
import type { ConnectorDraft, ConnectorOverviewItem } from './connectors';
import { draftFromItem } from './connectors';

export type MicrosoftSetupResult = {
  status: 'ok' | 'missingModule' | 'signInFailed' | 'needsAdminToSetUp' | 'failed';
  tenantId?: string | null;
  clientId?: string | null;
  created?: boolean;
  consent?: 'granted' | 'needsAdmin' | null;
  consentUrl?: string | null;
  /** Write permissions for the person who signed in: granted, needsAdmin, none, or notRemoved (couldn't take one back). */
  writeConsent?: 'granted' | 'needsAdmin' | 'none' | 'notRemoved' | null;
  message?: string | null;
};

/** What Claude can do through Claude Desktop's Microsoft 365 connector. Sending mail is never offered. */
export const MICROSOFT_ACCESS_LEVELS = ['readonly', 'drafts', 'calendar'] as const;
export type MicrosoftAccess = typeof MICROSOFT_ACCESS_LEVELS[number];

/**
 * Signs in to Microsoft in the browser and registers the Entra app Claude Desktop needs. Read access is approved for
 * the organization; the write permissions `access` adds are granted to the person signing in only.
 */
export const runMicrosoftSetup = (access: MicrosoftAccess) => invoke<MicrosoftSetupResult>('microsoft_auto_setup', { access });

/** The level to save after setup: write access Microsoft didn't grant falls back to read only. */
export function savedMicrosoftAccess(chosen: MicrosoftAccess, result: MicrosoftSetupResult): MicrosoftAccess {
  return chosen !== 'readonly' && result.writeConsent !== 'granted' ? 'readonly' : chosen;
}

/** The change that saves setup's IDs and access level and turns the connector on for Claude Desktop, leaving the rest as it is. */
export function draftWithSetupIds(item: ConnectorOverviewItem, result: MicrosoftSetupResult, access: MicrosoftAccess = 'readonly'): ConnectorDraft | null {
  if (result.status !== 'ok' || !result.tenantId || !result.clientId) return null;
  const draft = draftFromItem(item);
  return { ...draft, access, claudeDesktop: true, secrets: { ...draft.secrets, MICROSOFT_TENANT_ID: result.tenantId, MICROSOFT_CLIENT_ID: result.clientId } };
}

/** The one PowerShell command that installs what setup needs, for the current user only. */
export const GRAPH_MODULE_INSTALL = 'Install-Module Microsoft.Graph.Applications -Scope CurrentUser';
