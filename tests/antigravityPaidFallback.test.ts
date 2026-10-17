import { describe, expect, it } from 'bun:test';
import { antigravityPaidFallback, ANTIGRAVITY_PAID_FALLBACK_PATH } from '../src/services/antigravityPaidFallback';
import { settingFieldLocation } from '../src/services/settingsNavigation';

describe('Antigravity paid fallback', () => {
  it('reads the setting, then its older name, then the proxy default (on)', () => {
    expect(antigravityPaidFallback({ oauth: { providers: { antigravity: { 'antigravity-credits': false } } } })).toBe(false);
    expect(antigravityPaidFallback({ 'quota-exceeded': { 'antigravity-credits': false } })).toBe(false);
    // The current key wins over the older one.
    expect(antigravityPaidFallback({ oauth: { providers: { antigravity: { 'antigravity-credits': true } } }, 'quota-exceeded': { 'antigravity-credits': false } })).toBe(true);
    expect(antigravityPaidFallback({})).toBe(true);
  });

  it('its link lands on the one field that edits it', () => {
    expect(settingFieldLocation(ANTIGRAVITY_PAID_FALLBACK_PATH)).toMatchObject({ category: 'oauth', groupId: 'oauth-others' });
    expect(settingFieldLocation('no.such.setting')).toBeNull();
  });
});
