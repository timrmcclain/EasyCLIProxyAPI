import { describe, expect, it } from 'bun:test';
import { freshFindings, modeFor, openFindings, readPolicy, secretGuardApp, secretGuardService, type SecretGuardFinding } from '../src/services/secretGuard';
import { pluginsApi } from '../src/services/plugins';

const finding = (fingerprint: string, extra: Partial<SecretGuardFinding> = {}): SecretGuardFinding => ({
  fingerprint, kind: 'github_token', firstSeen: 1, lastSeen: 2, sightings: 1,
  providers: ['anthropic'], models: ['sonnet'], clients: ['claude-cli/2.1'], actions: ['reported'], dismissedAt: null, ...extra,
});
const policy = (allow: string[] = []) => ({ defaultMode: 'report' as const, modes: {}, allow });

describe('Secret Guard', () => {
  it('reads the plugin config, ignoring values it does not understand', () => {
    const read = readPolicy({ default_mode: 'redact', modes: { xai: 'block', openai: 'nonsense', unknown: 'block' }, allow: ['aaaa0001', 7] });
    expect(read).toEqual({ defaultMode: 'redact', modes: { xai: 'block' }, allow: ['aaaa0001'] });
    expect(modeFor(read, 'xai')).toBe('block');
    expect(modeFor(read, 'openai')).toBe('redact');
    expect(readPolicy({}).defaultMode).toBe('report');
  });

  it('names apps the way Activity does', () => {
    expect(secretGuardApp('claude-cli/2.1 (claude-desktop-3p)')).toBe('Claude Desktop');
    expect(secretGuardApp('claude-cli/2.1.280 (external, cli)')).toBe('Claude Code');
    expect(secretGuardApp('codex_cli_rs/0.40')).toBe('Codex');
    expect(secretGuardApp('curl/8.4')).toBe('curl');
  });

  it('leaves out findings that were rotated or marked safe', () => {
    const all = [finding('aaaa0001'), finding('bbbb0002', { dismissedAt: 5 }), finding('cccc0003')];
    expect(openFindings(all, policy(['cccc0003'])).map(item => item.fingerprint)).toEqual(['aaaa0001']);
  });

  it('notifies once per new secret, and not for what was there at startup', () => {
    const first = freshFindings(null, [finding('aaaa0001')], policy());
    expect(first.fresh).toEqual([]);
    const second = freshFindings(first.seen, [finding('aaaa0001'), finding('bbbb0002')], policy());
    expect(second.fresh.map(item => item.fingerprint)).toEqual(['bbbb0002']);
    const third = freshFindings(second.seen, [finding('aaaa0001'), finding('bbbb0002')], policy());
    expect(third.fresh).toEqual([]);
    const allowed = freshFindings(third.seen, [finding('dddd0004')], policy(['dddd0004']));
    expect(allowed.fresh).toEqual([]);
  });
  it('keeps the newest fingerprints at the end, where trimming keeps them', () => {
    const newestFirst = [finding('cccc0003'), finding('bbbb0002'), finding('aaaa0001')];
    expect([...freshFindings(null, newestFirst, policy()).seen]).toEqual(['aaaa0001', 'bbbb0002', 'cccc0003']);
  });

  it('never writes the policy back when its current config could not be read', async () => {
    const original = { getConfig: pluginsApi.getConfig, patchConfig: pluginsApi.patchConfig };
    const writes: unknown[] = [];
    pluginsApi.getConfig = async () => { throw new Error('Management API error (500): busy'); };
    pluginsApi.patchConfig = async (_id, changes) => { writes.push(changes); };
    try {
      await expect(secretGuardService.setMode('xai', 'block')).rejects.toThrow('busy');
      await expect(secretGuardService.setAllowed('aaaa0001', true)).rejects.toThrow('busy');
      expect(writes).toEqual([]);

      // Not configured yet ({}): the first write also gets a salt.
      pluginsApi.getConfig = async () => ({});
      await secretGuardService.setAllowed('aaaa0001', true);
      expect(writes[0]).toMatchObject({ allow: ['aaaa0001'], salt: expect.any(String) });
      pluginsApi.getConfig = async () => ({ salt: 'kept', allow: ['aaaa0001'] });
      await secretGuardService.setMode('xai', 'block');
      expect(writes[1]).toEqual({ modes: { xai: 'block' } });
    } finally {
      Object.assign(pluginsApi, original);
    }
  });
});
