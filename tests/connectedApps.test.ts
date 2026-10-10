import { describe, expect, it } from 'bun:test';
import { driftedApps, generateProxyKey, reapplyArguments, type ConnectedAppStatus } from '../src/services/connectedApps';

const app = (id: string, overrides: Partial<ConnectedAppStatus> = {}): ConnectedAppStatus => ({
  id, name: id, installed: true, connectionState: 'configured', currentModel: 'gpt-5', oauthConfiguration: false,
  claudeCodeModelMappings: null, claudeDesktopModelMappings: null, ...overrides,
});
const mappings = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };

describe('connected app drift', () => {
  it('lists only installed apps whose settings stopped matching the hub', () => {
    const statuses = [
      app('claude-code', { connectionState: 'needs-update' }),
      app('codex'),
      app('opencode', { connectionState: 'not-configured' }),
      app('zcode', { connectionState: 'needs-update', installed: false }),
    ];
    expect(driftedApps(statuses).map(status => status.id)).toEqual(['claude-code']);
  });

  it('re-applies Claude apps with their own model mappings', () => {
    expect(reapplyArguments(app('claude-code', { claudeCodeModelMappings: mappings }))).toEqual({
      client: 'claude-code', model: 'claude-sonnet-5-5', oauthConfiguration: false,
      claudeCodeModelMappings: mappings, claudeDesktopModelMappings: null,
    });
    expect(reapplyArguments(app('claude-desktop', { claudeDesktopModelMappings: mappings }))?.claudeDesktopModelMappings).toEqual(mappings);
  });

  it('keeps the current model for other apps and leaves Codex or unknown models to a manual repair', () => {
    expect(reapplyArguments(app('opencode', { currentModel: 'kimi-k2' }))?.model).toBe('kimi-k2');
    expect(reapplyArguments(app('codex'))).toBeNull();
    expect(reapplyArguments(app('opencode', { currentModel: null }))).toBeNull();
    expect(reapplyArguments(app('claude-code', { currentModel: 'x' }))?.model).toBe('x');
  });

  it('generates keys in the same format as Settings → Keys', () => {
    const key = generateProxyKey();
    expect(key).toMatch(/^sk-[0-9a-f]{48}$/);
    expect(generateProxyKey()).not.toBe(key);
  });
});
