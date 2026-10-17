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
  message?: string | null;
};

/** Signs in to Microsoft in the browser and registers the Entra app Claude Desktop needs. */
export const runMicrosoftSetup = () => invoke<MicrosoftSetupResult>('microsoft_auto_setup');

/** The change that saves setup's IDs and turns the connector on for Claude Desktop, leaving the rest as it is. */
export function draftWithSetupIds(item: ConnectorOverviewItem, result: MicrosoftSetupResult): ConnectorDraft | null {
  if (result.status !== 'ok' || !result.tenantId || !result.clientId) return null;
  const draft = draftFromItem(item);
  return { ...draft, claudeDesktop: true, secrets: { ...draft.secrets, MICROSOFT_TENANT_ID: result.tenantId, MICROSOFT_CLIENT_ID: result.clientId } };
}

/** The one PowerShell command that installs what setup needs, for the current user only. */
export const GRAPH_MODULE_INSTALL = 'Install-Module Microsoft.Graph.Applications -Scope CurrentUser';
