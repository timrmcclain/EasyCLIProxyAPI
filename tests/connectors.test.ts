import { describe, expect, test } from 'bun:test';
import { draftChanged, draftFromItem, invalidSecretFromError, missingSecretFromError, missingSecrets, type ConnectorOverviewItem } from '../src/services/connectors';

function item(overrides: Partial<ConnectorOverviewItem> = {}): ConnectorOverviewItem {
  return {
    id: 'google',
    accessLevels: ['readonly', 'drafts', 'full'],
    secretNames: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    secretsConfigured: true,
    secretsDesktopOnly: false,
    unavailableReason: null,
    claudeCode: { enabled: true, access: 'full', builtIn: false, signedIn: true },
    claudeDesktop: { enabled: false, access: null, builtIn: false, signedIn: null },
    ...overrides,
  };
}

describe('connector drafts', () => {
  test('starts from the saved state and is unchanged', () => {
    const saved = item();
    const draft = draftFromItem(saved);
    expect(draft).toEqual({ claudeCode: true, claudeDesktop: false, access: 'full', secrets: {} });
    expect(draftChanged(saved, draft)).toBe(false);
  });

  test('switches, access and typed secrets count as changes; blank secrets do not', () => {
    const saved = item();
    const draft = draftFromItem(saved);
    expect(draftChanged(saved, { ...draft, claudeDesktop: true })).toBe(true);
    expect(draftChanged(saved, { ...draft, access: 'readonly' })).toBe(true);
    expect(draftChanged(saved, { ...draft, secrets: { GOOGLE_OAUTH_CLIENT_ID: '  ' } })).toBe(false);
    expect(draftChanged(saved, { ...draft, secrets: { GOOGLE_OAUTH_CLIENT_ID: 'id' } })).toBe(true);
  });

  test('access is ignored when the connector is off everywhere', () => {
    const saved = item({ claudeCode: { enabled: false, access: null, builtIn: false, signedIn: null } });
    const draft = draftFromItem(saved);
    expect(draft.access).toBe('readonly');
    expect(draftChanged(saved, { ...draft, access: 'full' })).toBe(false);
  });

  test('asks for secrets only when none are stored and the connector is being turned on', () => {
    const fresh = item({ id: 'github', secretNames: ['GITHUB_TOKEN'], secretsConfigured: false, claudeCode: { enabled: false, access: null, builtIn: false, signedIn: null } });
    const off = draftFromItem(fresh);
    expect(missingSecrets(fresh, off)).toEqual([]);
    expect(missingSecrets(fresh, { ...off, claudeCode: true })).toEqual(['GITHUB_TOKEN']);
    expect(missingSecrets(fresh, { ...off, claudeCode: true, secrets: { GITHUB_TOKEN: 'token' } })).toEqual([]);
    expect(missingSecrets(item(), { ...draftFromItem(item()), claudeDesktop: true })).toEqual([]);
  });

  test('Microsoft 365 asks for its IDs only when Claude Desktop is turned on', () => {
    const m365 = item({
      id: 'microsoft365',
      accessLevels: [],
      secretNames: ['MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID'],
      secretsConfigured: false,
      secretsDesktopOnly: true,
      claudeCode: { enabled: false, access: null, builtIn: false, signedIn: null },
    });
    const off = draftFromItem(m365);
    expect(missingSecrets(m365, { ...off, claudeCode: true })).toEqual([]);
    expect(missingSecrets(m365, { ...off, claudeDesktop: true })).toEqual(['MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID']);
  });

  test('reads the malformed secret name from backend errors', () => {
    expect(invalidSecretFromError(new Error('invalid_secret:MICROSOFT_CLIENT_ID'))).toBe('MICROSOFT_CLIENT_ID');
    expect(invalidSecretFromError('missing_secret:GITHUB_TOKEN')).toBeNull();
  });

  test('reads the missing secret name from backend errors', () => {
    expect(missingSecretFromError('missing_secret:GITHUB_TOKEN')).toBe('GITHUB_TOKEN');
    expect(missingSecretFromError(new Error('missing_secret:GOOGLE_OAUTH_CLIENT_ID'))).toBe('GOOGLE_OAUTH_CLIENT_ID');
    expect(missingSecretFromError('something else')).toBeNull();
  });
});
